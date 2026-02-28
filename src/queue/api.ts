import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { openQueueDb } from './db.js';
import { loadQueueConfig } from './config.js';
import { QueueRepository } from './repository.js';
import type { TaskMode, TaskRow, TaskStatus } from './types.js';

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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function normalizeStatus(value: string | null): TaskStatus | null {
  if (!value) {
    return null;
  }
  if (['queued', 'leased', 'running', 'done', 'failed', 'blocked'].includes(value)) {
    return value as TaskStatus;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'blocked';
}

const RUN_WAIT_POLL_MS = 1000;
const RUN_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

function toApiTask(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    prompt: task.prompt,
    success_criteria: task.success_criteria,
    task_request: JSON.parse(task.task_request_json),
    status: task.status,
    attempt_count: task.attempt_count,
    max_attempts: task.max_attempts,
    priority: task.priority,
    lease_owner: task.lease_owner,
    lease_expires_at: task.lease_expires_at,
    last_error: task.last_error,
    created_at: task.created_at,
    updated_at: task.updated_at
  };
}

function extractUserOutput(output: Record<string, unknown> | null): string {
  if (!output) {
    return '';
  }

  const phaseOutputs = output.phase_outputs;
  if (phaseOutputs && typeof phaseOutputs === 'object' && !Array.isArray(phaseOutputs)) {
    const report = (phaseOutputs as Record<string, unknown>).report;
    if (report && typeof report === 'object' && !Array.isArray(report)) {
      const message = (report as Record<string, unknown>).message_markdown;
      if (typeof message === 'string' && message.trim().length > 0) {
        return message.trim();
      }
    }

    const execute = (phaseOutputs as Record<string, unknown>).execute;
    if (execute && typeof execute === 'object' && !Array.isArray(execute)) {
      const summary = (execute as Record<string, unknown>).summary;
      if (typeof summary === 'string' && summary.trim().length > 0) {
        return summary.trim();
      }
    }
  }

  const directOutput = output.output;
  if (typeof directOutput === 'string' && directOutput.trim().length > 0) {
    return directOutput.trim();
  }

  const error = output.error;
  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }

  return JSON.stringify(output);
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

      if (method === 'POST' && url.pathname === '/tasks/queue') {
        const body = await readJsonBody(req) as {
          prompt?: unknown;
          success_criteria?: unknown;
          type?: unknown;
          title?: unknown;
          priority?: unknown;
          metadata?: unknown;
          mode?: unknown;
        };

        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt is required' });
          return;
        }

        const successCriteriaRaw = body.success_criteria;
        const successCriteria = typeof successCriteriaRaw === 'string' ? successCriteriaRaw.trim() : undefined;
        if (successCriteriaRaw !== undefined && !successCriteria) {
          sendJson(res, 400, { error: 'success_criteria must be a non-empty string when provided' });
          return;
        }

        const type = typeof body.type === 'string' ? body.type.trim() : undefined;
        const title = typeof body.title === 'string' ? body.title.trim() : undefined;
        const priority = Number.isInteger(body.priority) ? Number(body.priority) : undefined;
        const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined;
        const mode = body.mode === 'lean' || body.mode === 'full' || body.mode === 'auto'
          ? body.mode as TaskMode
          : 'auto';

        const task = repo.createTask({ prompt, successCriteria, type, title, priority, metadata, mode }, config.maxAttempts);
        sendJson(res, 201, { task_id: task.id });
        return;
      }

      if (method === 'POST' && url.pathname === '/tasks/run') {
        const body = await readJsonBody(req) as {
          prompt?: unknown;
          success_criteria?: unknown;
          type?: unknown;
          title?: unknown;
          priority?: unknown;
          metadata?: unknown;
          mode?: unknown;
        };

        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (!prompt) {
          sendJson(res, 400, { error: 'prompt is required' });
          return;
        }

        const successCriteriaRaw = body.success_criteria;
        const successCriteria = typeof successCriteriaRaw === 'string' ? successCriteriaRaw.trim() : undefined;
        if (successCriteriaRaw !== undefined && !successCriteria) {
          sendJson(res, 400, { error: 'success_criteria must be a non-empty string when provided' });
          return;
        }

        const type = typeof body.type === 'string' ? body.type.trim() : undefined;
        const title = typeof body.title === 'string' ? body.title.trim() : undefined;
        const priority = Number.isInteger(body.priority) ? Number(body.priority) : 1;
        const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined;
        const mode = body.mode === 'lean' || body.mode === 'full' || body.mode === 'auto'
          ? body.mode as TaskMode
          : 'auto';

        const task = repo.createTask({ prompt, successCriteria, type, title, priority, metadata, mode }, config.maxAttempts);
        const deadline = Date.now() + RUN_WAIT_TIMEOUT_MS;
        let lastEventId = 0;
        let lastSequence = 0;
        let runIdForStream: string | null = null;

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache'
        });

        const writeNdjson = (obj: unknown): void => {
          res.write(`${JSON.stringify(obj)}\n`);
        };
        const nextSequence = (): number => {
          lastSequence += 1;
          return lastSequence;
        };
        const streamEventRow = (event: {
          phase: string;
          level: string;
          message: string;
          data_json: string;
          created_at: string;
        }): void => {
          try {
            const data = JSON.parse(event.data_json) as { envelope?: unknown };
            if (data.envelope && typeof data.envelope === 'object') {
              const envelope = data.envelope as Record<string, unknown>;
              const runId = envelope.run_id;
              if (typeof runId === 'string' && runId.length > 0) {
                runIdForStream = runId;
              }
              const sourceSequence = envelope.sequence;
              const normalized = { ...envelope, sequence: nextSequence() } as Record<string, unknown>;
              const payloadValue = normalized.payload;
              if (
                typeof sourceSequence === 'number'
                && Number.isInteger(sourceSequence)
                && payloadValue
                && typeof payloadValue === 'object'
                && !Array.isArray(payloadValue)
              ) {
                normalized.payload = {
                  ...(payloadValue as Record<string, unknown>),
                  source_sequence: sourceSequence
                };
              }
              writeNdjson(normalized);
              return;
            }

            // For non-envelope records (interpret/plan/policy/verify/report, etc.),
            // emit a normalized NDJSON event so full-mode progress is visible live.
            writeNdjson({
              run_id: runIdForStream ?? task.id,
              sequence: nextSequence(),
              timestamp: event.created_at,
              type: 'event',
              phase: event.phase,
              producer: 'system',
              payload: {
                level: event.level,
                message: event.message,
                data
              }
            });
          } catch {
            writeNdjson({
              run_id: runIdForStream ?? task.id,
              sequence: nextSequence(),
              timestamp: event.created_at,
              type: 'event',
              phase: event.phase,
              producer: 'system',
              payload: {
                level: event.level,
                message: event.message,
                data: {}
              }
            });
          }
        };

        writeNdjson({
          run_id: task.id,
          sequence: 0,
          timestamp: new Date().toISOString(),
          type: 'event',
          phase: 'intake',
          producer: 'system',
          payload: {
            level: 'info',
            message: 'Task accepted',
            data: { task_id: task.id, status: task.status, queue_priority: task.priority }
          }
        });

        let latest = repo.getTaskById(task.id) ?? task;
        while (!isTerminalStatus(latest.status) && Date.now() < deadline) {
          const eventsAsc = repo
            .listEvents(500, task.id)
            .slice()
            .sort((a, b) => a.id - b.id);

          for (const event of eventsAsc) {
            if (event.id <= lastEventId) {
              continue;
            }
            lastEventId = event.id;
            streamEventRow(event);
          }

          await sleep(RUN_WAIT_POLL_MS);
          const refreshed = repo.getTaskById(task.id);
          if (!refreshed) {
            writeNdjson({
              run_id: task.id,
              sequence: nextSequence(),
              timestamp: new Date().toISOString(),
              type: 'error',
              phase: 'execute',
              producer: 'system',
              payload: { code: 'TASK_DISAPPEARED', message: 'task disappeared during wait' }
            });
            res.end();
            return;
          }
          latest = refreshed;
        }

        const attempts = repo.getAttemptsForTask(task.id);
        const latestAttempt = attempts[attempts.length - 1] ?? null;
        let output: Record<string, unknown> | null = null;
        if (latestAttempt && typeof latestAttempt.output_json === 'string' && latestAttempt.output_json.length > 0) {
          try {
            output = JSON.parse(latestAttempt.output_json) as Record<string, unknown>;
          } catch {
            output = null;
          }
        }
        if (!isTerminalStatus(latest.status)) {
          writeNdjson({
            run_id: task.id,
            sequence: nextSequence(),
            timestamp: new Date().toISOString(),
            type: 'error',
            phase: 'execute',
            producer: 'system',
            payload: { code: 'RUN_WAIT_TIMEOUT', message: 'run wait timeout reached' }
          });
          res.end();
          return;
        }

        const eventsAsc = repo
          .listEvents(500, task.id)
          .slice()
          .sort((a, b) => a.id - b.id);
        for (const event of eventsAsc) {
          if (event.id <= lastEventId) {
            continue;
          }
          lastEventId = event.id;
          streamEventRow(event);
        }

        writeNdjson({
          run_id: runIdForStream ?? task.id,
          sequence: nextSequence(),
          timestamp: new Date().toISOString(),
          type: 'artifact',
          phase: 'execute',
          producer: 'system',
          payload: {
            name: 'final_output',
            format: 'markdown',
            content: extractUserOutput(output)
          }
        });
        res.end();
        return;
      }

      if (method === 'GET' && url.pathname === '/tasks') {
        const statusQuery = url.searchParams.get('status');
        const status = normalizeStatus(statusQuery);
        if (statusQuery && !status) {
          sendJson(res, 400, { error: 'invalid status filter' });
          return;
        }
        sendJson(res, 200, { tasks: repo.listTasks(status ?? undefined).map(toApiTask) });
        return;
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
      if (method === 'GET' && taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const task = repo.getTaskById(id);
        if (!task) {
          sendJson(res, 404, { error: 'task not found' });
          return;
        }

        sendJson(res, 200, toApiTask(task));
        return;
      }

      const taskAttemptsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/attempts$/);
      if (method === 'GET' && taskAttemptsMatch) {
        const id = decodeURIComponent(taskAttemptsMatch[1]);
        const task = repo.getTaskById(id);
        if (!task) {
          sendJson(res, 404, { error: 'task not found' });
          return;
        }

        sendJson(res, 200, { attempts: repo.getAttemptsForTask(id) });
        return;
      }

      const taskEventsMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
      if (method === 'GET' && taskEventsMatch) {
        const id = decodeURIComponent(taskEventsMatch[1]);
        const task = repo.getTaskById(id);
        if (!task) {
          sendJson(res, 404, { error: 'task not found' });
          return;
        }

        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : 200;
        sendJson(res, 200, { events: repo.listEvents(Number.isFinite(limit) ? limit : 200, id) });
        return;
      }

      if (method === 'POST' && url.pathname === '/tasks/lease') {
        const body = await readJsonBody(req) as { worker_id?: unknown; lease_ttl_ms?: unknown };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }

        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.defaultLeaseTtlMs;
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer' });
          return;
        }

        const task = repo.claimNextTask(workerId, leaseTtlMs);
        if (!task) {
          sendJson(res, 200, { task: null });
          return;
        }

        const attempt = repo.startAttempt(task.id, workerId);
        if (!attempt) {
          sendJson(res, 409, { error: 'failed to start attempt' });
          return;
        }

        const leasedTask = repo.getTaskById(task.id) ?? task;
        sendJson(res, 200, {
          task: toApiTask(leasedTask),
          attempt_no: attempt.attemptNo,
          attempt_id: attempt.attemptId
        });
        return;
      }

      const heartbeatMatch = url.pathname.match(/^\/tasks\/([^/]+)\/heartbeat$/);
      if (method === 'POST' && heartbeatMatch) {
        const id = decodeURIComponent(heartbeatMatch[1]);
        const body = await readJsonBody(req) as { worker_id?: unknown; lease_ttl_ms?: unknown };
        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }

        const leaseTtlMs = Number.isInteger(body.lease_ttl_ms)
          ? Number(body.lease_ttl_ms)
          : config.defaultLeaseTtlMs;
        if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
          sendJson(res, 400, { error: 'lease_ttl_ms must be a positive integer' });
          return;
        }

        repo.heartbeatLease(id, workerId, leaseTtlMs);
        sendJson(res, 200, { ok: true });
        return;
      }

      const completeMatch = url.pathname.match(/^\/tasks\/([^/]+)\/complete$/);
      if (method === 'POST' && completeMatch) {
        const id = decodeURIComponent(completeMatch[1]);
        const body = await readJsonBody(req) as {
          worker_id?: unknown;
          worker_exit_code?: unknown;
          output_json?: unknown;
          final_phase?: unknown;
          succeeded?: unknown;
          blocked?: unknown;
          error_message?: unknown;
          finished_at?: unknown;
        };

        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }

        const outputJson = body.output_json && typeof body.output_json === 'object'
          ? body.output_json as Record<string, unknown>
          : {};

        repo.completeAttempt(id, workerId, {
          workerExitCode: body.worker_exit_code === null || typeof body.worker_exit_code === 'number'
            ? body.worker_exit_code
            : null,
          outputJson,
          finalPhase: typeof body.final_phase === 'string' ? body.final_phase : 'commit',
          succeeded: body.succeeded === true,
          blocked: body.blocked === true,
          errorMessage: typeof body.error_message === 'string' ? body.error_message : null,
          finishedAt: typeof body.finished_at === 'string' ? body.finished_at : new Date().toISOString()
        });

        const task = repo.getTaskById(id);
        sendJson(res, 200, { ok: true, status: task?.status ?? null });
        return;
      }

      const eventsPostMatch = url.pathname.match(/^\/tasks\/([^/]+)\/events$/);
      if (method === 'POST' && eventsPostMatch) {
        const id = decodeURIComponent(eventsPostMatch[1]);
        const body = await readJsonBody(req) as {
          worker_id?: unknown;
          attempt_id?: unknown;
          phase?: unknown;
          level?: unknown;
          message?: unknown;
          data?: unknown;
        };

        const workerId = typeof body.worker_id === 'string' ? body.worker_id.trim() : '';
        if (!workerId) {
          sendJson(res, 400, { error: 'worker_id is required' });
          return;
        }

        const phase = typeof body.phase === 'string' ? body.phase : 'runtime';
        const level = body.level === 'warn' || body.level === 'error' ? body.level : 'info';
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message) {
          sendJson(res, 400, { error: 'message is required' });
          return;
        }

        repo.appendEvent({
          taskId: id,
          attemptId: Number.isInteger(body.attempt_id) ? Number(body.attempt_id) : null,
          phase,
          level,
          message,
          data: body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : {}
        });

        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'GET' && url.pathname === '/events') {
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw ? Number(limitRaw) : 50;
        const taskId = url.searchParams.get('task_id') ?? undefined;
        sendJson(res, 200, { events: repo.listEvents(Number.isFinite(limit) ? limit : 50, taskId) });
        return;
      }

      const stateGetMatch = url.pathname.match(/^\/state\/(.+)$/);
      if (method === 'GET' && stateGetMatch) {
        const key = decodeURIComponent(stateGetMatch[1]);
        const row = repo.getState(key);
        if (!row) {
          sendJson(res, 404, { error: 'state key not found' });
          return;
        }
        sendJson(res, 200, { key: row.key, value: JSON.parse(row.value_json), updated_at: row.updated_at });
        return;
      }

      const statePostMatch = url.pathname.match(/^\/state\/(.+)$/);
      if (method === 'POST' && statePostMatch) {
        const key = decodeURIComponent(statePostMatch[1]);
        const body = await readJsonBody(req) as { value?: unknown };
        const value = body.value && typeof body.value === 'object' ? body.value as Record<string, unknown> : {};
        repo.setState(key, value);
        const row = repo.getState(key);
        sendJson(res, 200, {
          ok: true,
          key,
          value,
          updated_at: row?.updated_at ?? new Date().toISOString()
        });
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
