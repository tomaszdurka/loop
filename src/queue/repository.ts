import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ArtifactRow,
  CompleteAttemptInput,
  CreateArtifactInput,
  CreateTaskInput,
  EventRow,
  ResponsibilityRow,
  StateRow,
  TaskStepRow,
  TaskAttemptRow,
  TaskRow,
  TaskStatus,
  UpsertTaskStepInput
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

  createChildTask(
    parentTaskId: string,
    input: CreateTaskInput,
    defaultMaxAttempts: number,
    policy: { maxChildDepth: number; maxChildrenPerTask: number }
  ): TaskRow {
    const tx = this.db.transaction(() => {
      const parent = this.getTaskById(parentTaskId);
      if (!parent) {
        throw new Error(`parent task not found: ${parentTaskId}`);
      }

      const depth = this.countTaskDepth(parentTaskId);
      if (depth >= policy.maxChildDepth) {
        throw new Error(`child depth limit reached (max=${policy.maxChildDepth})`);
      }

      const childCount = (this.db
        .prepare('SELECT COUNT(*) as count FROM tasks WHERE parent_task_id = ?')
        .get(parentTaskId) as { count: number }).count;
      if (childCount >= policy.maxChildrenPerTask) {
        throw new Error(`max children per task reached (max=${policy.maxChildrenPerTask})`);
      }

      const child = this.createTask(
        {
          ...input,
          parentTaskId
        },
        defaultMaxAttempts
      );

      const now = nowIso();
      this.db
        .prepare(
          `UPDATE tasks
           SET status = 'waiting_children', updated_at = ?
           WHERE id = ? AND status IN ('queued', 'leased', 'running')`
        )
        .run(now, parentTaskId);

      this.appendEvent('child_task_created', { child_task_id: child.id }, parentTaskId);
      this.appendEvent('child_task_linked', { parent_task_id: parentTaskId }, child.id);
      return child;
    });

    return tx();
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

      this.createArtifact({
        taskId,
        kind: 'text',
        bodyOrUri: result.output,
        meta: {
          worker_id: workerId,
          attempt_no: attemptNo,
          worker_exit_code: result.workerExitCode,
          judge_decision: result.judgeDecision,
          judge_explanation: result.judgeExplanation,
          succeeded: result.succeeded
        }
      });

      const parsedSteps = this.extractStepsFromOutput(result.output);
      for (const step of parsedSteps) {
        this.upsertTaskStep(taskId, {
          stepKey: step.stepKey,
          status: step.status,
          idempotencyKey: step.idempotencyKey,
          result: { note: step.note ?? null, source: 'output_marker' }
        });
      }

      this.appendEvent(result.succeeded ? 'task_completed' : 'task_failed', {
        worker_id: workerId,
        attempt_no: attemptNo,
        error_message: result.errorMessage,
        next_status: nextStatus,
        parsed_steps: parsedSteps.length
      }, taskId);

      if (task.parent_task_id) {
        this.reconcileParentAfterChildCompletion(task.parent_task_id);
      }
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

  listChildTasks(parentTaskId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC')
      .all(parentTaskId) as TaskRow[];
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
                 AND status IN ('queued', 'leased', 'running', 'waiting_children', 'blocked')
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

  upsertTaskStep(taskId: string, input: UpsertTaskStepInput): TaskStepRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO task_steps (
          task_id, step_key, status, idempotency_key, result_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, step_key) DO UPDATE SET
          status=excluded.status,
          idempotency_key=excluded.idempotency_key,
          result_json=excluded.result_json,
          updated_at=excluded.updated_at`
      )
      .run(
        taskId,
        input.stepKey,
        input.status,
        input.idempotencyKey ?? null,
        JSON.stringify(input.result ?? {}),
        now
      );

    return this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? AND step_key = ?')
      .get(taskId, input.stepKey) as TaskStepRow;
  }

  listTaskSteps(taskId: string): TaskStepRow[] {
    return this.db
      .prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY id ASC')
      .all(taskId) as TaskStepRow[];
  }

  createArtifact(input: CreateArtifactInput): ArtifactRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO artifacts (task_id, kind, body_or_uri, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.taskId ?? null,
        input.kind,
        input.bodyOrUri,
        JSON.stringify(input.meta ?? {}),
        now
      );

    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE rowid = last_insert_rowid()')
      .get() as ArtifactRow | undefined;
    if (!row) {
      throw new Error('Failed to create artifact row');
    }
    return row;
  }

  listArtifacts(limit = 50, taskId?: string): ArtifactRow[] {
    const safeLimit = Math.max(1, Math.min(500, limit));
    if (taskId) {
      return this.db
        .prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(taskId, safeLimit) as ArtifactRow[];
    }

    return this.db
      .prepare('SELECT * FROM artifacts ORDER BY created_at DESC LIMIT ?')
      .all(safeLimit) as ArtifactRow[];
  }

  private extractStepsFromOutput(output: string): Array<{
    stepKey: string;
    status: 'done' | 'failed';
    idempotencyKey?: string | null;
    note?: string | null;
  }> {
    const steps: Array<{
      stepKey: string;
      status: 'done' | 'failed';
      idempotencyKey?: string | null;
      note?: string | null;
    }> = [];

    // Marker format: STEP[<key>]: DONE|FAILED [idempotency=<token>] [note=<text>]
    const regex = /^STEP\[(.+?)\]:\s*(DONE|FAILED)(?:\s+idempotency=([^\s]+))?(?:\s+note=(.+))?$/gim;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(output)) !== null) {
      steps.push({
        stepKey: match[1].trim(),
        status: match[2].toUpperCase() === 'DONE' ? 'done' : 'failed',
        idempotencyKey: match[3]?.trim() ?? null,
        note: match[4]?.trim() ?? null
      });
    }

    return steps;
  }

  private countTaskDepth(taskId: string): number {
    let depth = 0;
    let currentId: string | null = taskId;
    while (currentId) {
      const row = this.db
        .prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
        .get(currentId) as { parent_task_id: string | null } | undefined;
      if (!row || !row.parent_task_id) {
        break;
      }
      depth += 1;
      currentId = row.parent_task_id;
    }
    return depth;
  }

  private reconcileParentAfterChildCompletion(parentTaskId: string): void {
    const children = this.listChildTasks(parentTaskId);
    if (children.length === 0) {
      return;
    }

    const hasActive = children.some((c) => c.status === 'queued' || c.status === 'leased' || c.status === 'running' || c.status === 'waiting_children');
    if (hasActive) {
      return;
    }

    const hasFailure = children.some((c) => c.status === 'failed' || c.status === 'blocked');
    const now = nowIso();
    const nextStatus: TaskStatus = hasFailure ? 'blocked' : 'queued';
    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, updated_at = ?
         WHERE id = ? AND status = 'waiting_children'`
      )
      .run(nextStatus, now, parentTaskId);

    this.appendEvent('parent_task_resolved_children', {
      next_status: nextStatus,
      child_count: children.length
    }, parentTaskId);
  }
}
