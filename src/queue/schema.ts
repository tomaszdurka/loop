import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      success_criteria TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at ON jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_lease_expires_at ON jobs(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);

    CREATE TABLE IF NOT EXISTS job_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      worker_exit_code INTEGER,
      judge_decision TEXT,
      judge_explanation TEXT,
      output TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE,
      UNIQUE(job_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_job_attempts_job_id_attempt_no ON job_attempts(job_id, attempt_no);
  `);

  // Backward-compatible migration for older local DBs that used stdout/stderr columns.
  const columns = db.prepare(`PRAGMA table_info(job_attempts)`).all() as Array<{ name: string }>;
  const hasOutput = columns.some((column) => column.name === 'output');
  const hasStdout = columns.some((column) => column.name === 'stdout');
  const hasStderr = columns.some((column) => column.name === 'stderr');
  if (!hasOutput) {
    db.exec(`ALTER TABLE job_attempts ADD COLUMN output TEXT NOT NULL DEFAULT ''`);
  }
  if (hasStdout || hasStderr) {
    db.exec(`
      UPDATE job_attempts
      SET output = TRIM(
        COALESCE(output, '') ||
        CASE
          WHEN COALESCE(output, '') <> '' AND COALESCE(stdout, '') <> '' THEN CHAR(10)
          ELSE ''
        END ||
        COALESCE(stdout, '') ||
        CASE
          WHEN (COALESCE(output, '') <> '' OR COALESCE(stdout, '') <> '') AND COALESCE(stderr, '') <> '' THEN CHAR(10)
          ELSE ''
        END ||
        COALESCE(stderr, '')
      )
      WHERE COALESCE(output, '') = '';
    `);
  }
}
