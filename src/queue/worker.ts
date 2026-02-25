import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openQueueDb } from './db.js';
import { loadQueueConfig } from './config.js';
import { QueueRepository } from './repository.js';
import type { JobRow } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
};

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Command not found: ${command}`
        : error.message;
      resolve({ exitCode: null, stdout, stderr, spawnError: message });
    });

    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr, spawnError: null });
    });
  });
}

async function runJobViaExistingLoop(job: JobRow): Promise<CommandResult> {
    const args = [
      'tsx',
      'src/agentic-loop-runner/index.ts',
      '--prompt',
      job.prompt,
    ]
    if (job.success_criteria) {
      args.push(...[
        '--success',
        job.success_criteria,
      ])
    }
  return runCommand('npx', args);
}

async function executeJob(repo: QueueRepository, workerId: string, leaseTtlMs: number, job: JobRow): Promise<void> {
  const started = repo.startAttempt(job.id, workerId);
  if (started === 0) {
    console.error(`[queue-worker] failed to start attempt for job ${job.id}`);
    return;
  }

  const heartbeat = setInterval(() => {
    repo.heartbeatLease(job.id, workerId, leaseTtlMs);
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));

  try {
    const result = await runJobViaExistingLoop(job);

    let judgeDecision: 'YES' | 'NO' | null = null;
    let judgeExplanation: string | null = null;

    if (job.success_criteria) {
      const text = `${result.stdout}\n${result.stderr}`;
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

    repo.completeAttempt(job.id, workerId, {
      workerExitCode: result.exitCode,
      judgeDecision,
      judgeExplanation,
      stdout: result.stdout,
      stderr: result.stderr,
      succeeded,
      errorMessage,
      finishedAt: new Date().toISOString()
    });

    console.log(`[queue-worker] job ${job.id} ${succeeded ? 'succeeded' : 'failed_or_requeued'}`);
  } catch (error) {
    repo.completeAttempt(job.id, workerId, {
      workerExitCode: null,
      judgeDecision: 'NO',
      judgeExplanation: 'Worker runtime error',
      stdout: '',
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
      succeeded: false,
      errorMessage: 'Worker runtime error',
      finishedAt: new Date().toISOString()
    });
    console.error(`[queue-worker] job ${job.id} runtime error`);
  } finally {
    clearInterval(heartbeat);
  }
}

export async function startQueueWorker(): Promise<void> {
  const config = loadQueueConfig();
  const db = openQueueDb(config.dbPath);
  const repo = new QueueRepository(db);
  const workerId = `worker-${randomUUID()}`;

  console.log(`[queue-worker] started: ${workerId}`);
  console.log(`[queue-worker] sqlite: ${config.dbPath}`);

  while (true) {
    const job = repo.claimNextJob(workerId, config.leaseTtlMs);
    if (!job) {
      await sleep(config.pollMs);
      continue;
    }

    console.log(`[queue-worker] claimed job ${job.id}`);
    await executeJob(repo, workerId, config.leaseTtlMs, job);
  }
}
