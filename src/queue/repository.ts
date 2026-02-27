import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CompleteAttemptInput,
  CreateTaskInput,
  EventRow,
  ResponsibilityRow,
  StateRow,
  TaskAttemptRow,
  TaskRow,
  TaskStatus
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStatus(status: TaskStatus | 'succeeded'): TaskStatus {
  return status === 'succeeded' ? 'done' : status;
}

export class QueueRepository {
  constructor(private readonly db: Database.Database) {}

  createTask(input: CreateTaskInput, defaultMaxAttempts: number): TaskRow {
    const id = randomUUID();
    const now = nowIso();
    const type = input.type?.trim() || 'generic';
    const title = input.title?.trim() || 'Untitled task';
    const successCriteria = input.successCriteria?.trim() || null;
    const payloadJson = JSON.stringify(input.payload ?? {});
    const priority = Number.isInteger(input.priority) ? Math.max(1, Math.min(5, input.priority!)) : 3;
    const maxAttempts = Number.isInteger(input.maxAttempts) ? Math.max(1, input.maxAttempts!) : defaultMaxAttempts;

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, type, title, prompt, success_criteria, payload_json, status, priority,
          attempt_count, max_attempts, next_run_at, parent_task_id, dedupe_key,
          lease_owner, lease_expires_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(
        id,
        type,
        title,
        input.prompt,
        successCriteria,
        payloadJson,
        priority,
        maxAttempts,
        input.nextRunAt ?? null,
        input.parentTaskId ?? null,
        input.dedupeKey ?? null,
        now,
        now
      );

    this.appendEvent('task_created', {
      type,
      title,
      priority,
      dedupe_key: input.dedupeKey ?? null
    }, id);

    return this.getTaskById(id)!;
  }

  getTaskById(id: string): TaskRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ?? null;
  }

  listTasks(status?: TaskStatus | 'succeeded'): TaskRow[] {
    if (status) {
      return this.db
        .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC')
        .all(normalizeStatus(status)) as TaskRow[];
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
        const isFinalFailure = nextAttempt >= task.max_attempts;
        const nextStatus: TaskStatus = isFinalFailure ? 'failed' : 'queued';
        const message = 'Lease expired before completion';

        this.db
          .prepare(
            `INSERT INTO task_attempts (
              task_id, attempt_no, status, worker_exit_code, judge_decision,
              judge_explanation, output, started_at, finished_at
            ) VALUES (?, ?, 'failed', NULL, NULL, NULL, ?, ?, ?)
            ON CONFLICT(task_id, attempt_no) DO UPDATE SET
              status='failed',
              output=excluded.output,
              finished_at=excluded.finished_at`
          )
          .run(task.id, nextAttempt, message, now, now);

        this.db
          .prepare(
            `UPDATE tasks SET
              status = ?,
              attempt_count = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = ?,
              updated_at = ?
            WHERE id = ?`
          )
          .run(nextStatus, nextAttempt, message, now, task.id);

        this.appendEvent('task_lease_expired', { next_status: nextStatus }, task.id);
      }

      return expired.length;
    });

    return tx();
  }

  claimNextTask(workerId: string, leaseTtlMs: number): TaskRow | null {
    const tx = this.db.transaction(() => {
      this.recoverExpiredLeases();

      const now = nowIso();
      const candidate = this.db
        .prepare(
          `SELECT id
           FROM tasks
           WHERE status = 'queued'
             AND (next_run_at IS NULL OR next_run_at <= ?)
           ORDER BY priority ASC, created_at ASC
           LIMIT 1`
        )
        .get(now) as { id: string } | undefined;

      if (!candidate) {
        return null;
      }

      const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

      const claimed = this.db
        .prepare(
          `UPDATE tasks SET
             status = 'leased',
             lease_owner = ?,
             lease_expires_at = ?,
             updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(workerId, leaseExpiresAt, now, candidate.id);

      if (claimed.changes !== 1) {
        return null;
      }

      this.appendEvent('task_leased', { worker_id: workerId, lease_expires_at: leaseExpiresAt }, candidate.id);
      return this.getTaskById(candidate.id);
    });

    return tx();
  }

  leaseTaskById(taskId: string, workerId: string, leaseTtlMs: number): TaskRow | null {
    const tx = this.db.transaction(() => {
      this.recoverExpiredLeases();

      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
      const claimed = this.db
        .prepare(
          `UPDATE tasks SET
             status = 'leased',
             lease_owner = ?,
             lease_expires_at = ?,
             updated_at = ?
           WHERE id = ? AND status = 'queued'`
        )
        .run(workerId, leaseExpiresAt, now, taskId);

      if (claimed.changes !== 1) {
        return null;
      }

      this.appendEvent('task_leased', { worker_id: workerId, lease_expires_at: leaseExpiresAt }, taskId);
      return this.getTaskById(taskId);
    });

    return tx();
  }

  startAttempt(taskId: string, workerId: string): number {
    const tx = this.db.transaction(() => {
      const task = this.db
        .prepare(`SELECT * FROM tasks WHERE id = ? AND lease_owner = ? AND status = 'leased'`)
        .get(taskId, workerId) as TaskRow | undefined;

      if (!task) {
        return 0;
      }

      const attemptNo = task.attempt_count + 1;
      const now = nowIso();

      this.db
        .prepare(`UPDATE tasks SET status='running', updated_at=? WHERE id=?`)
        .run(now, taskId);

      this.db
        .prepare(
          `INSERT INTO task_attempts (
            task_id, attempt_no, status, worker_exit_code, judge_decision,
            judge_explanation, output, started_at, finished_at
          ) VALUES (?, ?, 'running', NULL, NULL, NULL, '', ?, NULL)
          ON CONFLICT(task_id, attempt_no) DO UPDATE SET
            status='running',
            started_at=excluded.started_at,
            finished_at=NULL`
        )
        .run(taskId, attemptNo, now);

      this.appendEvent('task_started', { worker_id: workerId, attempt_no: attemptNo }, taskId);
      return attemptNo;
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
      const newAttemptCount = attemptNo;
      const nextStatus: TaskStatus = result.succeeded
        ? 'done'
        : newAttemptCount >= task.max_attempts
          ? 'failed'
          : 'queued';

      this.db
        .prepare(
          `INSERT INTO task_attempts (
             task_id, attempt_no, status, worker_exit_code, judge_decision,
             judge_explanation, output, started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, attempt_no) DO UPDATE SET
             status=excluded.status,
             worker_exit_code=excluded.worker_exit_code,
             judge_decision=excluded.judge_decision,
             judge_explanation=excluded.judge_explanation,
             output=excluded.output,
             finished_at=excluded.finished_at`
        )
        .run(
          taskId,
          attemptNo,
          result.succeeded ? 'done' : 'failed',
          result.workerExitCode,
          result.judgeDecision,
          result.judgeExplanation,
          result.output,
          result.finishedAt,
          result.finishedAt
        );

      this.db
        .prepare(
          `UPDATE tasks SET
             status = ?,
             attempt_count = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?
           WHERE id = ?`
        )
        .run(nextStatus, newAttemptCount, result.errorMessage, result.finishedAt, taskId);

      this.appendEvent(result.succeeded ? 'task_completed' : 'task_failed', {
        worker_id: workerId,
        attempt_no: attemptNo,
        error_message: result.errorMessage,
        next_status: nextStatus
      }, taskId);
    });

    tx();
  }

  appendEvent(kind: string, data: Record<string, unknown>, taskId?: string | null): void {
    const now = nowIso();
    this.db
      .prepare(`INSERT INTO events (task_id, kind, data_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(taskId ?? null, kind, JSON.stringify(data), now);
  }

  listEvents(limit = 50): EventRow[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    return this.db
      .prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as EventRow[];
  }

  setState(key: string, value: Record<string, unknown>): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now);
  }

  getState(key: string): StateRow | null {
    const row = this.db.prepare('SELECT * FROM state WHERE key = ?').get(key) as StateRow | undefined;
    return row ?? null;
  }

  listResponsibilities(): ResponsibilityRow[] {
    return this.db
      .prepare('SELECT * FROM responsibilities ORDER BY id ASC')
      .all() as ResponsibilityRow[];
  }

  runDueResponsibilities(defaultMaxAttempts: number): { considered: number; created: number } {
    const tx = this.db.transaction(() => {
      const now = new Date();
      const nowIsoValue = now.toISOString();
      const responsibilities = this.listResponsibilities().filter((r) => {
        if (r.enabled !== 1) {
          return false;
        }
        if (!r.last_run_at) {
          return true;
        }
        const lastRunAt = new Date(r.last_run_at).getTime();
        return Number.isFinite(lastRunAt) && now.getTime() - lastRunAt >= r.every_ms;
      });

      let created = 0;
      for (const responsibility of responsibilities) {
        const dedupeKey = responsibility.dedupe_key;
        if (dedupeKey) {
          const existing = this.db
            .prepare(
              `SELECT id FROM tasks
               WHERE dedupe_key = ?
                 AND status IN ('queued', 'leased', 'running', 'blocked')
               LIMIT 1`
            )
            .get(dedupeKey) as { id: string } | undefined;
          if (existing) {
            this.appendEvent('responsibility_skipped_duplicate', {
              responsibility_id: responsibility.id,
              dedupe_key: dedupeKey,
              existing_task_id: existing.id
            });

            this.db
              .prepare('UPDATE responsibilities SET last_run_at = ?, updated_at = ? WHERE id = ?')
              .run(nowIsoValue, nowIsoValue, responsibility.id);
            continue;
          }
        }

        const task = this.createTask(
          {
            type: responsibility.task_type,
            title: responsibility.task_title,
            prompt: responsibility.task_prompt,
            successCriteria: responsibility.task_success_criteria ?? undefined,
            payload: { responsibility_id: responsibility.id },
            priority: responsibility.priority,
            dedupeKey: responsibility.dedupe_key ?? undefined
          },
          defaultMaxAttempts
        );

        this.appendEvent('responsibility_dispatched_task', {
          responsibility_id: responsibility.id
        }, task.id);

        this.db
          .prepare('UPDATE responsibilities SET last_run_at = ?, updated_at = ? WHERE id = ?')
          .run(nowIsoValue, nowIsoValue, responsibility.id);

        created += 1;
      }

      this.setState('responsibilities.last_tick', {
        at: nowIsoValue,
        considered: responsibilities.length,
        created
      });

      return { considered: responsibilities.length, created };
    });

    return tx();
  }
}
