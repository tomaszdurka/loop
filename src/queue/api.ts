import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openQueueDb } from './db.js';
import { loadQueueConfig } from './config.js';
import { QueueRepository } from './repository.js';
import type { CompleteAttemptInput, JudgeDecisionValue, TaskStatus } from './types.js';

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

function normalizeStatus(value: string | null): TaskStatus | null {
  if (!value) {
    return null;
  }
  if (value === 'succeeded') {
    return 'done';
  }
  if (['queued', 'leased', 'running', 'waiting_children', 'done', 'failed', 'blocked'].includes(value)) {
    return value as TaskStatus;
  }
  return null;
}

function toApiTask(task: {
  id: string;
  type: string;
  title: string;
  prompt: string;
  success_criteria: string | null;
  payload_json: string;
  status: TaskStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  next_run_at: string | null;
  parent_task_id: string | null;
  dedupe_key: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    prompt: task.prompt,
    success_criteria: task.success_criteria,
    payload: JSON.parse(task.payload_json),
    status: task.status,
    attempt_count: task.attempt_count,
    max_attempts: task.max_attempts,
    priority: task.priority,
    next_run_at: task.next_run_at,
    parent_task_id: task.parent_task_id,
    dedupe_key: task.dedupe_key,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    last_error: task.last_error,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function isJudgeDecision(value: unknown): value is JudgeDecisionValue {
  return value === 'YES' || value === 'NO' || value === null;
}

function toApiJobFromTask(task: Record<string, unknown>): Record<string, unknown> {
  return {
    id: task.id,
    prompt: task.prompt,
    success_criteria: task.success_criteria,
    status: task.status === 'done' ? 'succeeded' : task.status,
    attempt_count: task.attempt_count,
    max_attempts: task.max_attempts,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    last_error: task.last_error,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
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

      if (method === 'POST' && (url.pathname === '/tasks' || url.pathname === '/jobs')) {
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

        const type = typeof (body as { type?: unknown }).type === 'string'
          ? (body as { type: string }).type.trim()
          : undefined;
        const title = typeof (body as { title?: unknown }).title === 'string'
          ? (body as { title: string }).title.trim()
          : undefined;
        const priority = Number.isInteger((body as { priority?: unknown }).priority)
          ? Number((body as { priority: number }).priority)
          : undefined;

        const task = repo.createTask(
          { prompt, successCriteria, type, title, priority },
          config.maxAttempts
        );

        sendJson(res, 201, {
          id: task.id,
          status: task.status,
          created_at: task.created_at
        });
        return;
      }

      const childTaskCreateMatch = url.pathname.match(/^\/tasks\/([^/]+)\/children$/);
      if (method === 'POST' && childTaskCreateMatch) {
        const parentTaskId = decodeURIComponent(childTaskCreateMatch[1]);
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

        const type = typeof (body as { type?: unknown }).type === 'string'
          ? (body as { type: string }).type.trim()
          : undefined;
        const title = typeof (body as { title?: unknown }).title === 'string'
          ? (body as { title: string }).title.trim()
          : undefined;
        const priority = Number.isInteger((body as { priority?: unknown }).priority)
          ? Number((body as { priority: number }).priority)
          : undefined;

        try {
          const task = repo.createChildTask(
            parentTaskId,
            { prompt, successCriteria, type, title, priority },
            config.maxAttempts,
            { maxChildDepth: config.maxChildDepth, maxChildrenPerTask: config.maxChildrenPerTask }
          );

          sendJson(res, 201, {
            id: task.id,
            parent_task_id: parentTaskId,
            status: task.status,
            created_at: task.created_at
          });
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (method === 'POST' && (url.pathname === '/tasks/lease' || url.pathname === '/jobs/lease')) {
        const body = await readJsonBody(req) as {
          worker_id?: unknown;
          lease_ttl_ms?: unknown;
        };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.defaultLeaseTtlMs;

        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer when provided' });
          return;
        }

        const task = repo.claimNextTask(workerId, leaseTtlMs);
        if (!task) {
          sendJson(res, 200, { task: null, job: null });
          return;
        }

        const startedAttempt = repo.startAttempt(task.id, workerId);
        if (startedAttempt === 0) {
          sendJson(res, 409, { error: 'failed to start attempt for leased task' });
          return;
        }

        const leasedTask = repo.getTaskById(task.id);
        const apiTask = leasedTask ? toApiTask(leasedTask) : toApiTask(task);
        sendJson(res, 200, {
          task: apiTask,
          job: toApiJobFromTask(apiTask),
          attempt_no: startedAttempt
        });
        return;
      }

      if (method === 'GET' && (url.pathname === '/tasks' || url.pathname === '/jobs')) {
        const statusQuery = url.searchParams.get('status');
        const normalizedStatus = normalizeStatus(statusQuery);
        if (statusQuery && !normalizedStatus) {
          sendJson(res, 400, { error: 'invalid status filter' });
          return;
        }

        const tasks = repo.listTasks(normalizedStatus ?? undefined);
        const apiTasks = tasks.map(toApiTask);
        if (url.pathname === '/tasks') {
          sendJson(res, 200, { tasks: apiTasks });
        } else {
          sendJson(res, 200, { jobs: apiTasks.map(toApiJobFromTask) });
        }
        return;
      }

      const taskMatch = url.pathname.match(/^\/(tasks|jobs)\/([^/]+)$/);
      if (method === 'GET' && taskMatch) {
        const resource = taskMatch[1];
        const id = decodeURIComponent(taskMatch[2]);
        const task = repo.getTaskById(id);
        if (!task) {
          sendJson(res, 404, { error: 'task not found' });
          return;
        }

        const attempts = repo.getAttemptsForTask(id);
        const steps = repo.listTaskSteps(id);
        const artifacts = repo.listArtifacts(20, id);
        const apiTask = toApiTask(task);
        if (resource === 'tasks') {
          sendJson(res, 200, {
            ...apiTask,
            attempts,
            steps,
            artifacts
          });
        } else {
          sendJson(res, 200, {
            ...toApiJobFromTask(apiTask),
            attempts: attempts.map((a) => ({ ...a, task_id: undefined, job_id: a.task_id, status: a.status === 'done' ? 'succeeded' : a.status }))
          });
        }
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/(tasks|jobs)\/([^/]+)\/heartbeat$/);
      if (method === 'POST' && heartbeatMatch) {
        const id = decodeURIComponent(heartbeatMatch[2]);
        const body = await readJsonBody(req) as { worker_id?: unknown; lease_ttl_ms?: unknown };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.defaultLeaseTtlMs;

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

      const leaseByIdMatch = url.pathname.match(/^\/(tasks|jobs)\/([^/]+)\/lease$/);
      if (method === 'POST' && leaseByIdMatch) {
        const id = decodeURIComponent(leaseByIdMatch[2]);
        const body = await readJsonBody(req) as { worker_id?: unknown; lease_ttl_ms?: unknown };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.defaultLeaseTtlMs;

        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer when provided' });
          return;
        }

        const task = repo.leaseTaskById(id, workerId, leaseTtlMs);
        if (!task) {
          sendJson(res, 409, { error: 'task is not available for lease' });
          return;
        }

        const startedAttempt = repo.startAttempt(task.id, workerId);
        if (startedAttempt === 0) {
          sendJson(res, 409, { error: 'failed to start attempt for leased task' });
          return;
        }

        const leasedTask = repo.getTaskById(task.id);
        const apiTask = leasedTask ? toApiTask(leasedTask) : toApiTask(task);
        sendJson(res, 200, {
          task: apiTask,
          job: toApiJobFromTask(apiTask),
          attempt_no: startedAttempt
        });
        return;
      }

      const completeMatch = url.pathname.match(/^\/(tasks|jobs)\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const id = decodeURIComponent(completeMatch[2]);
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
        const task = repo.getTaskById(id);
        sendJson(res, 200, { ok: true, status: task?.status ?? null });
        return;
      }

      if (method === 'GET' && url.pathname === '/events') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : 50;
        sendJson(res, 200, { events: repo.listEvents(Number.isFinite(limit) ? limit : 50) });
        return;
      }

      const taskStepsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/steps$/);
      if (method === 'GET' && taskStepsMatch) {
        const id = decodeURIComponent(taskStepsMatch[1]);
        sendJson(res, 200, { steps: repo.listTaskSteps(id) });
        return;
      }

      const taskChildrenMatch = url.pathname.match(/^\/tasks\/([^/]+)\/children$/);
      if (method === 'GET' && taskChildrenMatch) {
        const id = decodeURIComponent(taskChildrenMatch[1]);
        sendJson(res, 200, { tasks: repo.listChildTasks(id).map(toApiTask) });
        return;
      }

      if (method === 'GET' && url.pathname === '/artifacts') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : 50;
        const taskId = url.searchParams.get('task_id') ?? undefined;
        sendJson(res, 200, { artifacts: repo.listArtifacts(Number.isFinite(limit) ? limit : 50, taskId) });
        return;
      }

      if (method === 'GET' && url.pathname === '/responsibilities') {
        sendJson(res, 200, { responsibilities: repo.listResponsibilities() });
        return;
      }

      if (method === 'POST' && url.pathname === '/tick') {
        const result = repo.runDueResponsibilities(config.maxAttempts);
        sendJson(res, 200, result);
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
