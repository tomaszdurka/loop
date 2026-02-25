import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CompleteAttemptInput,
  CreateJobInput,
  JobAttemptRow,
  JobRow,
  JobStatus
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

export class QueueRepository {
  constructor(private readonly db: Database.Database) {}

  enqueueJob(input: CreateJobInput, maxAttempts: number): JobRow {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, prompt, success_criteria, status, attempt_count, max_attempts,
          lease_owner, lease_expires_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', 0, ?, NULL, NULL, NULL, ?, ?)`
      )
      .run(id, input.prompt, input.successCriteria ?? null, maxAttempts, now, now);

    return this.getJobById(id)!;
  }

  getJobById(id: string): JobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ?? null;
  }

  listJobs(status?: JobStatus): JobRow[] {
    if (status) {
      return this.db
        .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC')
        .all(status) as JobRow[];
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC').all() as JobRow[];
  }

  getAttemptsForJob(jobId: string): JobAttemptRow[] {
    return this.db
      .prepare('SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt_no ASC')
      .all(jobId) as JobAttemptRow[];
  }

  recoverExpiredLeases(): number {
    const tx = this.db.transaction(() => {
      const now = nowIso();
      const expired = this.db
        .prepare(
          `SELECT id, attempt_count, max_attempts
           FROM jobs
           WHERE status IN ('leased', 'running')
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < ?`
        )
        .all(now) as Array<{ id: string; attempt_count: number; max_attempts: number }>;

      for (const job of expired) {
        const nextAttempt = job.attempt_count + 1;
        const isFinalFailure = nextAttempt >= job.max_attempts;
        const nextStatus: JobStatus = isFinalFailure ? 'failed' : 'queued';
        const message = 'Lease expired before completion';

        this.db
          .prepare(
            `INSERT INTO job_attempts (
              job_id, attempt_no, status, worker_exit_code, judge_decision,
              judge_explanation, stdout, stderr, started_at, finished_at
            ) VALUES (?, ?, 'failed', NULL, NULL, NULL, '', ?, ?, ?)
            ON CONFLICT(job_id, attempt_no) DO UPDATE SET
              status='failed',
              stderr=excluded.stderr,
              finished_at=excluded.finished_at`
          )
          .run(job.id, nextAttempt, message, now, now);

        this.db
          .prepare(
            `UPDATE jobs SET
              status = ?,
              attempt_count = ?,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = ?,
              updated_at = ?
            WHERE id = ?`
          )
          .run(nextStatus, nextAttempt, message, now, job.id);
      }

      return expired.length;
    });

    return tx();
  }

  claimNextJob(workerId: string, leaseTtlMs: number): JobRow | null {
    const tx = this.db.transaction(() => {
      this.recoverExpiredLeases();

      const candidate = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
        .get() as { id: string } | undefined;

      if (!candidate) {
        return null;
      }

      const now = nowIso();
      const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();

      const claimed = this.db
        .prepare(
          `UPDATE jobs SET
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

      return this.getJobById(candidate.id);
    });

    return tx();
  }

  startAttempt(jobId: string, workerId: string): number {
    const tx = this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE id = ? AND lease_owner = ? AND status = 'leased'`)
        .get(jobId, workerId) as JobRow | undefined;

      if (!job) {
        return 0;
      }

      const attemptNo = job.attempt_count + 1;
      const now = nowIso();

      this.db
        .prepare(`UPDATE jobs SET status='running', updated_at=? WHERE id=?`)
        .run(now, jobId);

      this.db
        .prepare(
          `INSERT INTO job_attempts (
            job_id, attempt_no, status, worker_exit_code, judge_decision,
            judge_explanation, stdout, stderr, started_at, finished_at
          ) VALUES (?, ?, 'running', NULL, NULL, NULL, '', '', ?, NULL)
          ON CONFLICT(job_id, attempt_no) DO UPDATE SET
            status='running',
            started_at=excluded.started_at,
            finished_at=NULL`
        )
        .run(jobId, attemptNo, now);

      return attemptNo;
    });

    return tx();
  }

  heartbeatLease(jobId: string, workerId: string, leaseTtlMs: number): void {
    const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
    const now = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')`
      )
      .run(leaseExpiresAt, now, jobId, workerId);
  }

  completeAttempt(jobId: string, workerId: string, result: CompleteAttemptInput): void {
    const tx = this.db.transaction(() => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE id = ? AND lease_owner = ? AND status IN ('leased', 'running')`)
        .get(jobId, workerId) as JobRow | undefined;

      if (!job) {
        return;
      }

      const attemptNo = job.attempt_count + 1;
      const newAttemptCount = attemptNo;
      const nextStatus: JobStatus = result.succeeded
        ? 'succeeded'
        : newAttemptCount >= job.max_attempts
          ? 'failed'
          : 'queued';

      this.db
        .prepare(
          `INSERT INTO job_attempts (
             job_id, attempt_no, status, worker_exit_code, judge_decision,
             judge_explanation, stdout, stderr, started_at, finished_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id, attempt_no) DO UPDATE SET
             status=excluded.status,
             worker_exit_code=excluded.worker_exit_code,
             judge_decision=excluded.judge_decision,
             judge_explanation=excluded.judge_explanation,
             stdout=excluded.stdout,
             stderr=excluded.stderr,
             finished_at=excluded.finished_at`
        )
        .run(
          jobId,
          attemptNo,
          result.succeeded ? 'succeeded' : 'failed',
          result.workerExitCode,
          result.judgeDecision,
          result.judgeExplanation,
          result.stdout,
          result.stderr,
          result.finishedAt,
          result.finishedAt
        );

      this.db
        .prepare(
          `UPDATE jobs SET
             status = ?,
             attempt_count = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?
           WHERE id = ?`
        )
        .run(nextStatus, newAttemptCount, result.errorMessage, result.finishedAt, jobId);
    });

    tx();
  }
}
