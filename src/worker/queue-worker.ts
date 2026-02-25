import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkerConfig } from './config.js';
import type { WorkerRuntimeOptions } from './job-runner.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOP_ENTRYPOINT = resolve(PROJECT_ROOT, 'src', 'loop.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type JobsListResponse = {
  jobs: Array<{ id: string }>;
};

async function listQueuedJobIds(apiBaseUrl: string): Promise<string[]> {
  const response = await fetch(`${apiBaseUrl}/jobs?status=queued`);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const msg = (parsed as { error?: string; message?: string }).error
      ?? (parsed as { error?: string; message?: string }).message
      ?? `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return ((parsed as JobsListResponse).jobs ?? []).map((job) => job.id);
}

function spawnRunJob(jobId: string, streamJobLogs: boolean): Promise<number> {
  return new Promise((resolve) => {
    const args = ['tsx', LOOP_ENTRYPOINT, 'run-job', jobId];
    if (streamJobLogs) {
      args.push('--stream-job-logs');
    }

    const child = spawn('npx', args, { stdio: 'inherit', cwd: PROJECT_ROOT });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export async function startQueueWorker(options: WorkerRuntimeOptions = { streamJobLogs: false }): Promise<void> {
  const config = loadWorkerConfig();
  console.log(`[queue-worker] started`);
  console.log(`[queue-worker] api: ${config.apiBaseUrl}`);

  while (true) {
    try {
      const queuedJobIds = await listQueuedJobIds(config.apiBaseUrl);
      const nextJobId = queuedJobIds[0];
      if (!nextJobId) {
        await sleep(config.pollMs);
        continue;
      }

      console.log(`[queue-worker] dispatching job ${nextJobId}`);
      const exitCode = await spawnRunJob(nextJobId, options.streamJobLogs);
      if (exitCode !== 0) {
        await sleep(500);
      }
    } catch (error) {
      console.error(`[queue-worker] API error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(config.pollMs);
    }
  }
}
