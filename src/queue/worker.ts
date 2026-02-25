import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { loadQueueConfig } from './config.js';
import type { JobRow } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CommandResult = {
  exitCode: number | null;
  output: string;
  spawnError: string | null;
};

type LeaseResponse = {
  job: JobRow | null;
  attempt_no?: number;
};

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let output = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on('error', (error) => {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Command not found: ${command}`
        : error.message;
      resolve({ exitCode: null, output, spawnError: message });
    });

    child.on('close', (code) => {
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

async function leaseJob(baseUrl: string, workerId: string, leaseTtlMs: number): Promise<JobRow | null> {
  const leased = await postJson<LeaseResponse>(baseUrl, '/jobs/lease', {
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

async function runJobViaExistingLoop(job: JobRow): Promise<CommandResult> {
  if (!job.success_criteria) {
    return runCommand('codex', [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      job.prompt
    ]);
  }

  return runCommand('npx', [
    'tsx',
    'src/agentic-loop-runner/index.ts',
    '--prompt',
    job.prompt,
    '--success',
    job.success_criteria,
    '--max-iterations',
    '1'
  ]);
}

async function executeJob(baseUrl: string, workerId: string, leaseTtlMs: number, job: JobRow): Promise<void> {
  const heartbeatTimer = setInterval(() => {
    heartbeat(baseUrl, workerId, job.id, leaseTtlMs).catch((error) => {
      console.error(`[queue-worker] heartbeat failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));

  try {
    const result = await runJobViaExistingLoop(job);

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
      output: result.output,
      succeeded,
      error_message: errorMessage,
      finished_at: new Date().toISOString()
    });

    console.log(`[queue-worker] job ${job.id} ${succeeded ? 'succeeded' : 'failed_or_requeued'}`);
  } catch (error) {
    await complete(baseUrl, workerId, job.id, {
      worker_exit_code: null,
      judge_decision: 'NO',
      judge_explanation: 'Worker runtime error',
      output: error instanceof Error ? error.stack ?? error.message : String(error),
      succeeded: false,
      error_message: 'Worker runtime error',
      finished_at: new Date().toISOString()
    });
    console.error(`[queue-worker] job ${job.id} runtime error`);
  } finally {
    clearInterval(heartbeatTimer);
  }
}

export async function startQueueWorker(): Promise<void> {
  const config = loadQueueConfig();
  const workerId = `worker-${randomUUID()}`;

  console.log(`[queue-worker] started: ${workerId}`);
  console.log(`[queue-worker] api: ${config.apiBaseUrl}`);

  while (true) {
    try {
      const job = await leaseJob(config.apiBaseUrl, workerId, config.leaseTtlMs);
      if (!job) {
        await sleep(config.pollMs);
        continue;
      }

      console.log(`[queue-worker] leased job ${job.id}`);
      await executeJob(config.apiBaseUrl, workerId, config.leaseTtlMs, job);
    } catch (error) {
      console.error(`[queue-worker] API error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(config.pollMs);
    }
  }
}
