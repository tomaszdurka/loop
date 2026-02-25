#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { loadWorkerConfig } from './config.js';
import { leaseJobById, runLeasedJob } from './job-runner.js';
import { startQueueWorker } from './queue-worker.js';

function readArgValue(flag: string): string | null {
  const args = process.argv.slice(2);
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
  const streamJobLogs = process.argv.slice(2).includes('--stream-job-logs');
  const jobId = readArgValue('--job-id');

  if (!jobId) {
    await startQueueWorker({ streamJobLogs });
    return;
  }

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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
