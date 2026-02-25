import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openQueueDb } from './db.js';
import { loadQueueConfig } from './config.js';
import { QueueRepository } from './repository.js';
import type { CompleteAttemptInput, JobStatus, JudgeDecisionValue } from './types.js';

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(serialized)
  });
  res.end(serialized);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

function toApiJob(job: {
  id: string;
  prompt: string;
  success_criteria: string | null;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): Record<string, unknown> {
  return {
    id: job.id,
    prompt: job.prompt,
    success_criteria: job.success_criteria,
    status: job.status,
    attempt_count: job.attempt_count,
    max_attempts: job.max_attempts,
    lease_owner: job.lease_owner,
    lease_expires_at: job.lease_expires_at,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at
  };
}

function isJudgeDecision(value: unknown): value is JudgeDecisionValue {
  return value === 'YES' || value === 'NO' || value === null;
}

export function startQueueApi(): void {
  const config = loadQueueConfig();
  const db = openQueueDb(config.dbPath);
  const repo = new QueueRepository(db);

  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && url.pathname === '/jobs') {
        const body = await readJsonBody(req);
        const prompt = typeof (body as { prompt?: unknown }).prompt === 'string'
          ? (body as { prompt: string }).prompt.trim()
          : '';
        const successCriteriaRaw = (body as { success_criteria?: unknown }).success_criteria;
        const successCriteria = typeof successCriteriaRaw === 'string' ? successCriteriaRaw.trim() : undefined;

        if (!prompt) {
          sendJson(res, 400, { error: 'prompt is required' });
          return;
        }

        if (successCriteriaRaw !== undefined && !successCriteria) {
          sendJson(res, 400, { error: 'success_criteria must be a non-empty string when provided' });
          return;
        }

        const job = repo.enqueueJob(
          { prompt, successCriteria },
          config.maxAttempts
        );

        sendJson(res, 201, {
          id: job.id,
          status: job.status,
          created_at: job.created_at
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/jobs/lease') {
        const body = await readJsonBody(req) as {
          worker_id?: unknown;
          lease_ttl_ms?: unknown;
        };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.leaseTtlMs;

        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer when provided' });
          return;
        }

        const job = repo.claimNextJob(workerId, leaseTtlMs);
        if (!job) {
          sendJson(res, 200, { job: null });
          return;
        }

        const startedAttempt = repo.startAttempt(job.id, workerId);
        if (startedAttempt === 0) {
          sendJson(res, 409, { error: 'failed to start attempt for leased job' });
          return;
        }

        const leasedJob = repo.getJobById(job.id);
        sendJson(res, 200, {
          job: leasedJob ? toApiJob(leasedJob) : toApiJob(job),
          attempt_no: startedAttempt
        });
        return;
      }

      if (method === 'GET' && url.pathname === '/jobs') {
        const statusQuery = url.searchParams.get('status');
        if (statusQuery && !['queued', 'leased', 'running', 'succeeded', 'failed'].includes(statusQuery)) {
          sendJson(res, 400, { error: 'invalid status filter' });
          return;
        }

        const jobs = repo.listJobs(statusQuery as JobStatus | null ?? undefined);
        sendJson(res, 200, { jobs: jobs.map(toApiJob) });
        return;
      }

      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const id = decodeURIComponent(jobMatch[1]);
        const job = repo.getJobById(id);
        if (!job) {
          sendJson(res, 404, { error: 'job not found' });
          return;
        }

        const attempts = repo.getAttemptsForJob(id);
        sendJson(res, 200, {
          ...toApiJob(job),
          attempts
        });
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/jobs\/([^/]+)\/heartbeat$/);
      if (method === 'POST' && heartbeatMatch) {
        const id = decodeURIComponent(heartbeatMatch[1]);
        const body = await readJsonBody(req) as { worker_id?: unknown; lease_ttl_ms?: unknown };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.leaseTtlMs;

        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer when provided' });
          return;
        }

        repo.heartbeatLease(id, workerId, leaseTtlMs);
        sendJson(res, 200, { ok: true });
        return;
      }

      const completeMatch = url.pathname.match(/^\/jobs\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const id = decodeURIComponent(completeMatch[1]);
        const body = await readJsonBody(req) as {
          worker_id?: unknown;
          worker_exit_code?: unknown;
          judge_decision?: unknown;
          judge_explanation?: unknown;
          output?: unknown;
          succeeded?: unknown;
          error_message?: unknown;
          finished_at?: unknown;
        };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }

        const workerExitCode = body.worker_exit_code === null || typeof body.worker_exit_code === 'number'
          ? body.worker_exit_code
          : null;
        const judgeDecision = body.judge_decision === undefined ? null : body.judge_decision;
        const judgeExplanation = typeof body.judge_explanation === 'string' ? body.judge_explanation : null;
        const output = typeof body.output === 'string' ? body.output : '';
        const succeeded = body.succeeded === true;
        const errorMessage = typeof body.error_message === 'string' ? body.error_message : null;
        const finishedAt = typeof body.finished_at === 'string' ? body.finished_at : new Date().toISOString();

        if (!isJudgeDecision(judgeDecision)) {
          sendJson(res, 400, { error: 'judge_decision must be YES, NO, or null' });
          return;
        }

        const completeInput: CompleteAttemptInput = {
          workerExitCode,
          judgeDecision,
          judgeExplanation,
          output,
          succeeded,
          errorMessage,
          finishedAt
        };

        repo.completeAttempt(id, workerId, completeInput);
        const job = repo.getJobById(id);
        sendJson(res, 200, { ok: true, status: job?.status ?? null });
        return;
      }

      notFound(res);
    } catch (error) {
      sendJson(res, 500, {
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  server.listen(config.apiPort, () => {
    console.log(`[queue-api] listening on http://localhost:${config.apiPort}`);
    console.log(`[queue-api] sqlite: ${config.dbPath}`);
  });
}
