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

type TasksListResponse = {
  tasks: Array<{ id: string }>;
};

async function listQueuedTaskIds(apiBaseUrl: string): Promise<string[]> {
  const response = await fetch(`${apiBaseUrl}/tasks?status=queued`);
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const msg = (parsed as { error?: string; message?: string }).error
      ?? (parsed as { error?: string; message?: string }).message
      ?? `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return ((parsed as TasksListResponse).tasks ?? []).map((task) => task.id);
}

function spawnRunJob(taskId: string, streamJobLogs: boolean): Promise<number> {
  return new Promise((resolve) => {
    const args = ['tsx', LOOP_ENTRYPOINT, 'run-job', taskId];
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
      const queuedTaskIds = await listQueuedTaskIds(config.apiBaseUrl);
      const nextTaskId = queuedTaskIds[0];
      if (!nextTaskId) {
        await sleep(config.pollMs);
        continue;
      }

      console.log(`[queue-worker] dispatching task ${nextTaskId}`);
      const exitCode = await spawnRunJob(nextTaskId, options.streamJobLogs);
      if (exitCode !== 0) {
        await sleep(500);
      }
    } catch (error) {
      console.error(`[queue-worker] API error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(config.pollMs);
    }
  }
}
