#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQueueApi } from './queue/api.js';
import { openQueueDb } from './queue/db.js';
import { loadQueueConfig } from './queue/config.js';
import { QueueRepository } from './queue/repository.js';
import { runAgenticLoopCommand, type AgenticLoopConfig } from './agentic-loop-runner/index.js';
import { loadWorkerConfig } from './worker/config.js';
import { leaseJobById, runLeasedJob } from './worker/job-runner.js';
import { startQueueWorker } from './worker/queue-worker.js';
import { parseCliArgs } from './lib/cli-args.js';
import type { TaskStatus } from './queue/types.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): string {
  return [
    'Usage:',
    '  loop gateway',
    '  loop run "<prompt>" [--success "..."] [--provider codex|claude] [--max-iterations N] [--cwd "/path"]',
    '  loop run-job <task-id> [--stream-job-logs]',
    '  loop worker [--stream-job-logs]',
    '  loop db:migrate',
    '  loop tick',
    '  loop status',
    '  loop tasks:list [--status queued|leased|running|done|failed|blocked]',
    '  loop tasks:create --prompt "..." [--type TYPE] [--title TITLE] [--priority 1..5] [--success "..."]',
    '  loop events:tail [--limit N]',
    '  loop responsibilities:list'
  ].join('\n');
}

function parseRunConfig(argv: string[]): AgenticLoopConfig {
  const parsed = parseCliArgs(argv);

  const prompt = parsed.positional[0];
  if (!prompt) {
    throw new Error('run requires a positional prompt argument');
  }

  const success = parsed.named.get('--success');
  const provider = parsed.named.get('--provider') ?? 'codex';
  if (provider !== 'codex' && provider !== 'claude') {
    throw new Error('--provider must be one of: codex, claude');
  }

  const maxIterationsRaw = parsed.named.get('--max-iterations') ?? '5';
  const maxIterations = Number(maxIterationsRaw);
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error('--max-iterations must be an integer >= 1');
  }

  const cwd = parsed.named.get('--cwd') ?? process.cwd();
  return { prompt, success, provider, maxIterations, cwd };
}

function parseTaskStatus(value: string | undefined): TaskStatus | undefined {
  if (!value) {
    return undefined;
  }

  if (value === 'queued' || value === 'leased' || value === 'running' || value === 'done' || value === 'failed' || value === 'blocked') {
    return value;
  }

  throw new Error('--status must be one of: queued|leased|running|done|failed|blocked');
}

function withRepo<T>(fn: (repo: QueueRepository) => T): T {
  const queueConfig = loadQueueConfig();
  const db = openQueueDb(queueConfig.dbPath);
  try {
    const repo = new QueueRepository(db);
    return fn(repo);
  } finally {
    db.close();
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    process.exit(0);
  }

  if (command === 'gateway') {
    startQueueApi();
    return;
  }

  if (command === 'db:migrate') {
    const config = loadQueueConfig();
    const db = openQueueDb(config.dbPath);
    db.close();
    console.log(`[db] schema ready: ${config.dbPath}`);
    return;
  }

  if (command === 'tick') {
    const config = loadQueueConfig();
    const result = withRepo((repo) => repo.runDueResponsibilities(config.maxAttempts));
    printJson(result);
    return;
  }

  if (command === 'status') {
    const data = withRepo((repo) => {
      const tasks = repo.listTasks();
      const counts = {
        queued: tasks.filter((t) => t.status === 'queued').length,
        leased: tasks.filter((t) => t.status === 'leased').length,
        running: tasks.filter((t) => t.status === 'running').length,
        done: tasks.filter((t) => t.status === 'done').length,
        failed: tasks.filter((t) => t.status === 'failed').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length
      };
      const recentEvents = repo.listEvents(10);
      return { counts, recent_events: recentEvents };
    });

    printJson(data);
    return;
  }

  if (command === 'tasks:list') {
    const parsed = parseCliArgs(args.slice(1));
    const status = parseTaskStatus(parsed.named.get('--status'));
    const tasks = withRepo((repo) => repo.listTasks(status));
    printJson({ tasks });
    return;
  }

  if (command === 'tasks:create') {
    const parsed = parseCliArgs(args.slice(1));
    const prompt = parsed.named.get('--prompt')?.trim() ?? '';
    if (!prompt) {
      throw new Error('tasks:create requires --prompt');
    }

    const priorityRaw = parsed.named.get('--priority');
    const priority = priorityRaw ? Number(priorityRaw) : undefined;
    if (priorityRaw) {
      const parsedPriority = Number(priorityRaw);
      if (!Number.isInteger(parsedPriority) || parsedPriority < 1 || parsedPriority > 5) {
        throw new Error('--priority must be an integer between 1 and 5');
      }
    }

    const config = loadQueueConfig();
    const task = withRepo((repo) => repo.createTask(
      {
        prompt,
        successCriteria: parsed.named.get('--success') ?? undefined,
        type: parsed.named.get('--type') ?? undefined,
        title: parsed.named.get('--title') ?? undefined,
        priority: priority ?? undefined
      },
      config.maxAttempts
    ));

    printJson({
      id: task.id,
      status: task.status,
      created_at: task.created_at
    });
    return;
  }

  if (command === 'events:tail') {
    const parsed = parseCliArgs(args.slice(1));
    const limitRaw = parsed.named.get('--limit') ?? '50';
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('--limit must be an integer between 1 and 500');
    }

    const events = withRepo((repo) => repo.listEvents(limit));
    printJson({ events });
    return;
  }

  if (command === 'responsibilities:list') {
    const responsibilities = withRepo((repo) => repo.listResponsibilities());
    printJson({ responsibilities });
    return;
  }

  if (command === 'run') {
    const rest = args.slice(1);
    try {
      const config = parseRunConfig(rest);
      await runAgenticLoopCommand(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid run arguments';
      console.error(message);
      console.error(usage());
      process.exit(2);
    }
    return;
  }

  if (command === 'run-job') {
    const runJobArgs = parseCliArgs(args.slice(1));
    const taskId = runJobArgs.positional[0];
    if (!taskId) {
      console.error('run-job requires <task-id>');
      console.error(usage());
      process.exit(2);
    }

    const streamJobLogs = runJobArgs.flags.has('--stream-job-logs');
    const config = loadWorkerConfig();
    const workerId = `worker-${randomUUID()}`;
    console.log(`[job-runner] started: ${workerId}`);
    console.log(`[job-runner] api: ${config.apiBaseUrl}`);
    console.log(`[job-runner] leasing task: ${taskId}`);

    const task = await leaseJobById(config.apiBaseUrl, workerId, config.leaseTtlMs, taskId);
    if (!task) {
      console.error(`[job-runner] task ${taskId} is not available for lease`);
      process.exit(1);
    }

    const succeeded = await runLeasedJob(config.apiBaseUrl, workerId, config.leaseTtlMs, task, { streamJobLogs });
    process.exit(succeeded ? 0 : 1);
    return;
  }

  if (command === 'worker') {
    const workerArgs = parseCliArgs(args.slice(1));
    const streamJobLogs = workerArgs.flags.has('--stream-job-logs');
    await startQueueWorker({ streamJobLogs });
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error(usage());
  process.exit(2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
