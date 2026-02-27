import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskRow } from '../queue/types.js';

export type WorkerRuntimeOptions = {
  streamJobLogs: boolean;
};

type CommandResult = {
  exitCode: number | null;
  output: string;
  spawnError: string | null;
};

type LeaseResponse = {
  task: TaskRow | null;
  attempt_no?: number;
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_ROOT = resolve(PROJECT_ROOT, 'runs');
const LOOP_ENTRYPOINT = resolve(PROJECT_ROOT, 'src', 'loop.ts');
const SYSTEM_PROMPTS_DIR = resolve(PROJECT_ROOT, 'prompts', 'system');

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

export async function leaseNextJob(baseUrl: string, workerId: string, leaseTtlMs: number): Promise<TaskRow | null> {
  const leased = await postJson<LeaseResponse>(baseUrl, '/tasks/lease', {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
  return leased.task;
}

export async function leaseJobById(baseUrl: string, workerId: string, leaseTtlMs: number, jobId: string): Promise<TaskRow | null> {
  const leased = await postJson<LeaseResponse>(baseUrl, `/tasks/${encodeURIComponent(jobId)}/lease`, {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
  return leased.task;
}

async function heartbeat(baseUrl: string, workerId: string, taskId: string, leaseTtlMs: number): Promise<void> {
  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
}

async function complete(baseUrl: string, workerId: string, taskId: string, payload: {
  worker_exit_code: number | null;
  judge_decision: 'YES' | 'NO' | null;
  judge_explanation: string | null;
  output: string;
  succeeded: boolean;
  error_message: string | null;
  finished_at: string;
}): Promise<void> {
  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/complete`, {
    worker_id: workerId,
    ...payload
  });
}

function createRunDir(runId: string): string {
  const runDir = resolve(RUNS_ROOT, runId);
  mkdirSync(runDir, { recursive: true });
  const sourceAgentsDir = resolve(PROJECT_ROOT, '.agents');
  const targetAgentsDir = resolve(runDir, '.agents');
  if (existsSync(sourceAgentsDir)) {
    cpSync(sourceAgentsDir, targetAgentsDir, { recursive: true });
  }
  return runDir;
}

async function runJobViaExistingLoop(
  task: TaskRow,
  runDir: string,
  runId: string,
  streamJobLogs: boolean
): Promise<CommandResult> {
  const effectivePrompt = buildEffectiveTaskPrompt(task);
  const args = [
    'tsx',
    LOOP_ENTRYPOINT,
    'run',
    effectivePrompt,
    '--cwd',
    runDir,
    '--max-iterations',
    '1'
  ];

  if (task.success_criteria) {
    args.push('--success', task.success_criteria);
  }

  const onOutputLine = streamJobLogs
    ? (line: string) => {
      console.log(`[RUN#${runId}]: ${line}`);
    }
    : undefined;

  return runCommand('npx', args, runDir, onOutputLine);
}

function readSystemPromptFile(name: string): string {
  const filePath = resolve(SYSTEM_PROMPTS_DIR, name);
  if (!existsSync(filePath)) {
    return '';
  }

  return readFileSync(filePath, 'utf8').trim();
}

function buildEffectiveTaskPrompt(task: TaskRow): string {
  const executor = readSystemPromptFile('executor.md');
  const capabilities = readSystemPromptFile('capabilities.md');
  const responsibilityDispatcher = readSystemPromptFile('responsibility-dispatcher.md');
  const isResponsibilityTask = isTaskFromResponsibility(task);

  const parts = [
    executor ? `## System Executor\n${executor}` : '',
    capabilities ? `## System Capabilities\n${capabilities}` : '',
    isResponsibilityTask && responsibilityDispatcher
      ? `## System Responsibility Dispatcher\n${responsibilityDispatcher}`
      : '',
    `## Task\n${task.prompt.trim()}`
  ].filter((p) => p.length > 0);

  return `${parts.join('\n\n')}\n`;
}

function isTaskFromResponsibility(task: TaskRow): boolean {
  try {
    const payload = JSON.parse(task.payload_json) as { responsibility_id?: unknown };
    return typeof payload.responsibility_id === 'string' && payload.responsibility_id.length > 0;
  } catch {
    return false;
  }
}

export async function runLeasedJob(
  baseUrl: string,
  workerId: string,
  leaseTtlMs: number,
  task: TaskRow,
  options: WorkerRuntimeOptions
): Promise<boolean> {
  const runId = `${task.id}-${Date.now()}`;
  const runDir = createRunDir(runId);
  const heartbeatTimer = setInterval(() => {
    heartbeat(baseUrl, workerId, task.id, leaseTtlMs).catch((error) => {
      console.error(`[queue-worker] heartbeat failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));

  try {
    const result = await runJobViaExistingLoop(task, runDir, runId, options.streamJobLogs);
    const outputWithRunDir = `RUN_DIR=${runDir}\n\n${result.output}`;

    let judgeDecision: 'YES' | 'NO' | null = null;
    let judgeExplanation: string | null = null;

    if (task.success_criteria) {
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

    await complete(baseUrl, workerId, task.id, {
      worker_exit_code: result.exitCode,
      judge_decision: judgeDecision,
      judge_explanation: judgeExplanation,
      output: outputWithRunDir,
      succeeded,
      error_message: errorMessage,
      finished_at: new Date().toISOString()
    });

    console.log(`[queue-worker] task ${task.id} ${succeeded ? 'done' : 'failed_or_requeued'}`);
    return succeeded;
  } catch (error) {
    await complete(baseUrl, workerId, task.id, {
      worker_exit_code: null,
      judge_decision: 'NO',
      judge_explanation: 'Worker runtime error',
      output: `RUN_DIR=${runDir}\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      succeeded: false,
      error_message: 'Worker runtime error',
      finished_at: new Date().toISOString()
    });
    console.error(`[queue-worker] task ${task.id} runtime error`);
    return false;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
