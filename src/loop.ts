#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startQueueApi } from './queue/api.js';
import { runAgenticLoopCommand, type AgenticLoopConfig } from './agentic-loop-runner/index.js';
import { loadWorkerConfig } from './worker/config.js';
import { leaseJobById, runLeasedJob } from './worker/job-runner.js';
import { startQueueWorker } from './worker/queue-worker.js';
import { parseCliArgs } from './lib/cli-args.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage(): string {
  return [
    'Usage:',
    '  loop gateway',
    '  loop run "<prompt>" [--success "..."] [--provider codex|claude] [--max-iterations N] [--cwd "/path"]',
    '  loop run-job <job-id> [--stream-job-logs]',
    '  loop worker [--stream-job-logs]'
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

function readArgValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index === -1) {
    return null;
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    return null;
  }
  return value;
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

  if (command === 'run') {
    const rest = args.slice(1);
    try {
      const config = parseRunConfig(rest);
      console.log(config)
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
    const jobId = runJobArgs.positional[0];
    if (!jobId) {
      console.error('run-job requires <job-id>');
      console.error(usage());
      process.exit(2);
    }

    const streamJobLogs = runJobArgs.flags.has('--stream-job-logs');
    const config = loadWorkerConfig();
    const workerId = `worker-${randomUUID()}`;
    console.log(`[job-runner] started: ${workerId}`);
    console.log(`[job-runner] api: ${config.apiBaseUrl}`);
    console.log(`[job-runner] leasing job: ${jobId}`);

    const job = await leaseJobById(config.apiBaseUrl, workerId, config.leaseTtlMs, jobId);
    if (!job) {
      console.error(`[job-runner] job ${jobId} is not available for lease`);
      process.exit(1);
    }

    const succeeded = await runLeasedJob(config.apiBaseUrl, workerId, config.leaseTtlMs, job, { streamJobLogs });
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
