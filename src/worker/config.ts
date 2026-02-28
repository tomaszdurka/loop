export type WorkerConfig = {
  apiBaseUrl: string;
  pollMs: number;
  leaseTtlMs: number;
  phaseTimeoutMs: number;
};

function intFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadWorkerConfig(): WorkerConfig {
  const apiBaseUrlRaw = process.env.WORKER_API_BASE_URL
    ?? process.env.QUEUE_API_BASE_URL
    ?? 'http://localhost:7070';

  return {
    apiBaseUrl: apiBaseUrlRaw.replace(/\/+$/, ''),
    pollMs: intFromEnv('WORKER_POLL_MS', intFromEnv('QUEUE_POLL_MS', 2000)),
    leaseTtlMs: intFromEnv('WORKER_LEASE_TTL_MS', intFromEnv('QUEUE_LEASE_TTL_MS', 120000)),
    phaseTimeoutMs: intFromEnv('WORKER_PHASE_TIMEOUT_MS', 10 * 60 * 1000)
  };
}
