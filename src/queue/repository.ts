import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CompleteAttemptInput,
  CreateTaskInput,
  EventRow,
  StateRow,
  TaskAttemptRow,
  TaskAttemptStatus,
  TaskRow,
  TaskStatus
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function deriveTitleFromPrompt(prompt: string): string {
  const normalized = prompt
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>"']/g, '')
    .trim();
  if (!normalized) {
    return 'Untitled task';
  }

  const firstSentence = normalized
    .split(/[.!?]/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? normalized;

  const title = firstSentence.length > 72
    ? `${firstSentence.slice(0, 72).trim()}...`
    : firstSentence;
  return title || 'Untitled task';
}

function envelopeEventData(taskId: string, phase: string, level: 'info' | 'warn' | 'error', eventName: string, message: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    envelope: {
      run_id: taskId,
      sequence: 0,
      timestamp: nowIso(),
      type: 'event',
      phase,
      producer: 'system',
      payload: {
        event_name: eventName,
        level,
        message,
        data
      }
    }
  };
}

export class QueueRepository {
  constructor(private readonly db: Database.Database) {}

  createTask(input: CreateTaskInput, defaultMaxAttempts: number): TaskRow {
    const id = randomUUID();
    const now = nowIso();
    const type = input.type?.trim() || 'generic';
    const mode = input.mode ?? 'auto';
    const title = input.title?.trim() || (mode === 'full' ? deriveTitleFromPrompt(input.prompt) : 'Untitled task');
    const successCriteria = input.successCriteria?.trim() || null;
    const metadata = input.metadata ?? {};
    const priority = Number.isInteger(input.priority) ? Math.max(1, Math.min(5, input.priority!)) : 3;
    const maxAttempts = Number.isInteger(input.maxAttempts) ? Math.max(1, input.maxAttempts!) : defaultMaxAttempts;

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, type, title, prompt, success_criteria, task_request_json, status, priority,
          attempt_count, max_attempts, lease_owner, lease_expires_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        type,
        title,
        input.prompt,
        successCriteria,
        JSON.stringify({ metadata, source: 'api', mode }),
        priority,
        maxAttempts,
        now,
        now
      );

    this.appendEvent({
      taskId: id,
      phase: 'intake',
      level: 'info',
      message: 'Task created',
      data: envelopeEventData(id, 'intake', 'info', 'task_created', 'Task created', { type, title, priority })
    });

    return this.getTaskById(id)!;
  }

  getTaskById(id: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ?? null;
  }

  listTasks(status?: TaskStatus): TaskRow[] {
    if (status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC')
        .all(status) as TaskRow[];
    }
    return this.db.prepare('SELECT * FROM tasks ORDER BY priority ASC, created_at ASC').all() as TaskRow[];
  }

  getAttemptsForTask(taskId: string): TaskAttemptRow[] {
    return this.db
      .prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_no ASC')
      .all(taskId) as TaskAttemptRow[];
  }

  recoverExpiredLeases(): number {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      const expired = this.db
        .prepare(
          `SELECT id, attempt_count, max_attempts
           FROM tasks
           WHERE status IN ('leased', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`
        )
        .all(now) as Array<{ id: string; attempt_count: number; max_attempts: number }>;

      for (const task of expired) {
        const nextAttempt = task.attempt_count + 1;
        const terminal = nextAttempt >= task.max_attempts;
        const nextStatus: TaskStatus = terminal ? 'failed' : 'queued';

        this.db
          .prepare(
            `UPDATE tasks
             SET status = ?,
                 attempt_count = ?,
                 lease_owner = NULL,
                 lease_expires_at = NULL,
                 last_error = ?,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(nextStatus, nextAttempt, 'Lease expired before completion', now, task.id);

        this.appendEvent({
          taskId: task.id,
          phase: 'lease',
          level: 'warn',
          message: 'Lease expired',
          data: envelopeEventData(task.id, 'lease', 'warn', 'lease_expired', 'Lease expired', { next_status: nextStatus })
        });
      }

      return expired.length;
    });

    return tx();
  }

  claimNextTask(workerId: string, leaseTtlMs: number): TaskRow | null {
    const tx = this.db.transaction(() => {
      this.recoverExpiredLeases();

      const candidate = this.db
        .prepare(
          `SELECT id
           FROM tasks
           WHERE status = 'queued'
           ORDER BY priority ASC, created_at ASC
           LIMIT 1`
        )
        .get() as { id: string } | undefined;

      if (!candidate) {
        return null;
      }

      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
      const claimed = this.db
        .prepare(
          `UPDATE tasks
           SET status = 'leased',
               lease_owner = ?,
               lease_expires_at = ?,
               updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(workerId, leaseExpiresAt, now, candidate.id);

      if (claimed.changes !== 1) {
        return null;
      }

      this.appendEvent({
        taskId: candidate.id,
        phase: 'lease',
        level: 'info',
        message: 'Task leased',
        data: envelopeEventData(candidate.id, 'lease', 'info', 'task_leased', 'Task leased', {
          worker_id: workerId,
          lease_expires_at: leaseExpiresAt
        })
      });

      return this.getTaskById(candidate.id);
    });

    return tx();
  }

  startAttempt(taskId: string, workerId: string): { attemptNo: number; attemptId: number; leaseExpiresAt: string } | null {
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare(`SELECT * FROM tasks WHERE id = ? AND lease_owner = ? AND status = 'leased'`)
        .get(taskId, workerId) as TaskRow | undefined;

      if (!task || !task.lease_expires_at) {
        return null;
      }

      const attemptNo = task.attempt_count + 1;
      const now = nowIso();

      this.db
        .prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`)
        .run(now, taskId);

      this.db
        .prepare(
          `INSERT INTO task_attempts (
             task_id, attempt_no, lease_owner, lease_expires_at, status, phase, output_json, started_at, finished_at
           ) VALUES (?, ?, ?, ?, 'running', 'preflight', '{}', ?, NULL)`
        )
        .run(taskId, attemptNo, workerId, task.lease_expires_at, now);

      const attempt = this.db
        .prepare('SELECT * FROM task_attempts WHERE task_id = ? AND attempt_no = ?')
        .get(taskId, attemptNo) as TaskAttemptRow | undefined;
      if (!attempt) {
        return null;
      }

      this.appendEvent({
        taskId,
        attemptId: attempt.id,
        phase: 'preflight',
        level: 'info',
        message: 'Attempt started',
        data: envelopeEventData(taskId, 'preflight', 'info', 'attempt_started', 'Attempt started', {
          attempt_no: attemptNo,
          worker_id: workerId
        })
      });

      return { attemptNo, attemptId: attempt.id, leaseExpiresAt: task.lease_expires_at };
    });

    return tx();
  }

  heartbeatLease(taskId: string, workerId: string, leaseTtlMs: number): void {
    const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE tasks
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')`
      )
      .run(leaseExpiresAt, now, taskId, workerId);

    this.db
      .prepare(
        `UPDATE task_attempts
         SET lease_expires_at = ?
         WHERE task_id = ?
           AND lease_owner = ?
           AND status = 'running'
         ORDER BY attempt_no DESC
         LIMIT 1`
      )
      .run(leaseExpiresAt, taskId, workerId);
  }

  completeAttempt(taskId: string, workerId: string, result: CompleteAttemptInput): void {
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare(`SELECT * FROM tasks WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')`)
        .get(taskId, workerId) as TaskRow | undefined;

      if (!task) {
        return;
      }

      const attemptNo = task.attempt_count + 1;
      const attempt = this.db
        .prepare('SELECT * FROM task_attempts WHERE task_id = ? AND attempt_no = ?')
        .get(taskId, attemptNo) as TaskAttemptRow | undefined;

      const attemptStatus: TaskAttemptStatus = result.blocked
        ? 'blocked'
        : result.succeeded
          ? 'done'
          : 'failed';

      const nextStatus: TaskStatus = result.blocked
        ? 'blocked'
        : result.succeeded
          ? 'done'
          : attemptNo >= task.max_attempts
            ? 'failed'
            : 'queued';

      if (attempt) {
        this.db
          .prepare(
            `UPDATE task_attempts
             SET status = ?, phase = ?, output_json = ?, finished_at = ?
             WHERE id = ?`
          )
          .run(attemptStatus, result.finalPhase, JSON.stringify(result.outputJson), result.finishedAt, attempt.id);
      }

      this.db
        .prepare(
          `UPDATE tasks
           SET status = ?,
               attempt_count = ?,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(nextStatus, attemptNo, result.errorMessage, result.finishedAt, taskId);

      this.appendEvent({
        taskId,
        attemptId: attempt?.id ?? null,
        phase: result.finalPhase,
        level: result.succeeded ? 'info' : 'error',
        message: result.succeeded ? 'Task completed' : 'Task failed',
        data: envelopeEventData(
          taskId,
          result.finalPhase,
          result.succeeded ? 'info' : 'error',
          result.succeeded ? 'task_completed' : 'task_failed',
          result.succeeded ? 'Task completed' : 'Task failed',
          {
          worker_id: workerId,
          worker_exit_code: result.workerExitCode,
          next_status: nextStatus,
          error_message: result.errorMessage
        }
        )
      });
    });

    tx();
  }

  updateAttemptProgress(attemptId: number, phase: string, outputJson: Record<string, unknown>): void {
    this.db
      .prepare('UPDATE task_attempts SET phase = ?, output_json = ? WHERE id = ?')
      .run(phase, JSON.stringify(outputJson), attemptId);
  }

  appendEvent(input: {
    taskId?: string | null;
    attemptId?: number | null;
    phase: string;
    level: 'info' | 'warn' | 'error';
    message: string;
    data?: Record<string, unknown>;
  }): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO events (task_id, attempt_id, phase, level, message, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.taskId ?? null,
        input.attemptId ?? null,
        input.phase,
        input.level,
        input.message,
        JSON.stringify(input.data ?? {}),
        now
      );
  }

  listEvents(limit = 50, taskId?: string): EventRow[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    if (taskId) {
      return this.db
        .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(taskId, safeLimit) as EventRow[];
    }

    return this.db
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as EventRow[];
  }

  setState(key: string, value: Record<string, unknown>): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO run_state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now);
  }

  getState(key: string): StateRow | null {
    const row = this.db.prepare('SELECT * FROM run_state WHERE key = ?').get(key) as StateRow | undefined;
    return row ?? null;
  }
}
