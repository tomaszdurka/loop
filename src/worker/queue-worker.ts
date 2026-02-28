import { loadWorkerConfig } from './config.js';
import { leaseNextJob, runLeasedJob, type WorkerRuntimeOptions } from './job-runner.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateWorkerId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const timePart = Date.now().toString(36).slice(-4).padStart(4, '0');
  let randomPart = '';
  for (let i = 0; i < 4; i += 1) {
    randomPart += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${timePart}${randomPart}`;
}

export async function startQueueWorker(options: WorkerRuntimeOptions): Promise<void> {
  const config = loadWorkerConfig();
  const workerId = generateWorkerId();

  console.log('[queue-worker] started');
  console.log(`[queue-worker] worker_id: ${workerId}`);
  console.log(`[queue-worker] api: ${config.apiBaseUrl}`);
  console.log(`[queue-worker] provider: ${options.provider}`);

  while (true) {
    try {
      const leased = await leaseNextJob(config.apiBaseUrl, workerId, config.leaseTtlMs);
      if (!leased.task) {
        await sleep(config.pollMs);
        continue;
      }

      console.log(`[queue-worker] running task ${leased.task.id}`);
      const succeeded = await runLeasedJob(
        config.apiBaseUrl,
        workerId,
        config.leaseTtlMs,
        leased.task,
        leased.attemptId,
        options
      );

      if (!succeeded) {
        await sleep(500);
      }
    } catch (error) {
      console.error(`[queue-worker] error: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(config.pollMs);
    }
  }
}
