#!/usr/bin/env node

import { startQueueWorker } from '../queue/worker.js';

startQueueWorker().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
