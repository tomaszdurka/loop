#!/usr/bin/env node

import { parseCliArgs } from '../lib/cli-args.js';
import { startQueueWorker } from './queue-worker.js';

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  const streamJobLogs = parsed.flags.has('--stream-job-logs');
  const providerRaw = parsed.named.get('--provider') ?? 'claude';
  if (providerRaw !== 'codex' && providerRaw !== 'claude') {
    throw new Error('--provider must be one of: codex, claude');
  }

  await startQueueWorker({ streamJobLogs, provider: providerRaw });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
