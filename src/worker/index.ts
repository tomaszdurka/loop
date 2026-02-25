#!/usr/bin/env node

import { startQueueWorker } from './worker.js';

const streamJobLogs = process.argv.slice(2).includes('--stream-job-logs');

startQueueWorker({ streamJobLogs }).catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
