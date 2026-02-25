import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRow } from '../queue/types.js';

export type WorkerRuntimeOptions = {
  streamJobLogs: boolean;
};

type CommandResult = {
  exitCode: number | null;
  output: string;
  spawnError: string | null;
};

type LeaseResponse = {
  job: JobRow | null;
  attempt_no?: number;
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_ROOT = resolve(PROJECT_ROOT, 'runs');
const LOOP_ENTRYPOINT = resolve(PROJECT_ROOT, 'src', 'loop.ts');

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onOutputLine?: (line: string) => void
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });

    let output = '';
    let lineBuffer = '';

    const emitLines = (chunkText: string): void => {
      if (!onOutputLine) {
        return;
      }
      lineBuffer += chunkText;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        onOutputLine(line);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      emitLines(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      emitLines(text);
    });

    child.on('error', (error) => {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Command not found: ${command}`
        : error.message;
      resolve({ exitCode: null, output, spawnError: message });
    });

    child.on('close', (code) => {
      if (onOutputLine && lineBuffer.length > 0) {
        onOutputLine(lineBuffer);
      }
      resolve({ exitCode: code, output, spawnError: null });
    });
  });
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const msg = (parsed as { error?: string; message?: string }).error
      ?? (parsed as { error?: string; message?: string }).message
      ?? `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return parsed as T;
}

export async function leaseNextJob(baseUrl: string, workerId: string, leaseTtlMs: number): Promise<JobRow | null> {
  const leased = await postJson<LeaseResponse>(baseUrl, '/jobs/lease', {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
  return leased.job;
}

export async function leaseJobById(baseUrl: string, workerId: string, leaseTtlMs: number, jobId: string): Promise<JobRow | null> {
  const leased = await postJson<LeaseResponse>(baseUrl, `/jobs/${encodeURIComponent(jobId)}/lease`, {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
  return leased.job;
}

async function heartbeat(baseUrl: string, workerId: string, jobId: string, leaseTtlMs: number): Promise<void> {
  await postJson(baseUrl, `/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
}

async function complete(baseUrl: string, workerId: string, jobId: string, payload: {
  worker_exit_code: number | null;
  judge_decision: 'YES' | 'NO' | null;
  judge_explanation: string | null;
  output: string;
  succeeded: boolean;
  error_message: string | null;
  finished_at: string;
}): Promise<void> {
  await postJson(baseUrl, `/jobs/${encodeURIComponent(jobId)}/complete`, {
    worker_id: workerId,
    ...payload
  });
}

function createRunDir(runId: string): string {
  const runDir = resolve(RUNS_ROOT, runId);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}

async function runJobViaExistingLoop(
  job: JobRow,
  runDir: string,
  runId: string,
  streamJobLogs: boolean
): Promise<CommandResult> {
  const args = [
    'tsx',
    LOOP_ENTRYPOINT,
    'run',
    job.prompt,
    '--cwd',
    runDir,
    '--max-iterations',
    '1'
  ];

  if (job.success_criteria) {
    args.push('--success', job.success_criteria);
  }

  const onOutputLine = streamJobLogs
    ? (line: string) => {
      console.log(`[RUN#${runId}]: ${line}`);
    }
    : undefined;

  return runCommand('npx', args, runDir, onOutputLine);
}

export async function runLeasedJob(
  baseUrl: string,
  workerId: string,
  leaseTtlMs: number,
  job: JobRow,
  options: WorkerRuntimeOptions
): Promise<boolean> {
  const runId = `${job.id}-${Date.now()}`;
  const runDir = createRunDir(runId);
  const heartbeatTimer = setInterval(() => {
    heartbeat(baseUrl, workerId, job.id, leaseTtlMs).catch((error) => {
      console.error(`[queue-worker] heartbeat failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));

  try {
    const result = await runJobViaExistingLoop(job, runDir, runId, options.streamJobLogs);
    const outputWithRunDir = `RUN_DIR=${runDir}\n\n${result.output}`;

    let judgeDecision: 'YES' | 'NO' | null = null;
    let judgeExplanation: string | null = null;

    if (job.success_criteria) {
      const text = result.output;
      if (/Judge decision:\s*YES/i.test(text)) {
        judgeDecision = 'YES';
      } else if (/Judge decision:\s*NO/i.test(text)) {
        judgeDecision = 'NO';
      }

      const match = text.match(/Judge decision:\s*(YES|NO)\s*-\s*([^\n\r]+)/i);
      judgeExplanation = match ? match[2].trim() : null;
    }

    const succeeded = result.spawnError === null && result.exitCode === 0;
    const errorMessage = succeeded
      ? null
      : (result.spawnError ?? `Runner exit code ${result.exitCode ?? 'null'}`);

    await complete(baseUrl, workerId, job.id, {
      worker_exit_code: result.exitCode,
      judge_decision: judgeDecision,
      judge_explanation: judgeExplanation,
      output: outputWithRunDir,
      succeeded,
      error_message: errorMessage,
      finished_at: new Date().toISOString()
    });

    console.log(`[queue-worker] job ${job.id} ${succeeded ? 'succeeded' : 'failed_or_requeued'}`);
    return succeeded;
  } catch (error) {
    await complete(baseUrl, workerId, job.id, {
      worker_exit_code: null,
      judge_decision: 'NO',
      judge_explanation: 'Worker runtime error',
      output: `RUN_DIR=${runDir}\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      succeeded: false,
      error_message: 'Worker runtime error',
      finished_at: new Date().toISOString()
    });
    console.error(`[queue-worker] job ${job.id} runtime error`);
    return false;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
