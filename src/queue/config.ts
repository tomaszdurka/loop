export type QueueConfig = {
  dbPath: string;
  pollMs: number;
  leaseTtlMs: number;
  maxAttempts: number;
  apiPort: number;
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

export function loadQueueConfig(): QueueConfig {
  return {
    dbPath: process.env.QUEUE_DB_PATH ?? './data/queue.sqlite',
    pollMs: intFromEnv('QUEUE_POLL_MS', 2000),
    leaseTtlMs: intFromEnv('QUEUE_LEASE_TTL_MS', 120000),
    maxAttempts: intFromEnv('QUEUE_MAX_ATTEMPTS', 3),
    apiPort: intFromEnv('QUEUE_API_PORT', 7070)
  };
}
