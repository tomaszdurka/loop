import type Database from 'better-sqlite3';

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) as { name: string } | undefined;
  return Boolean(row?.name);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'generic',
      title TEXT NOT NULL DEFAULT 'Untitled task',
      prompt TEXT NOT NULL,
      success_criteria TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_run_at TEXT,
      parent_task_id TEXT,
      dedupe_key TEXT,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created_at ON tasks(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run_at ON tasks(next_run_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_dedupe_key ON tasks(dedupe_key);

    CREATE TABLE IF NOT EXISTS task_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL,
      worker_exit_code INTEGER,
      judge_decision TEXT,
      judge_explanation TEXT,
      output TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id_attempt_no ON task_attempts(task_id, attempt_no);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_task_id_created_at ON events(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS task_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, step_key)
    );

    CREATE INDEX IF NOT EXISTS idx_task_steps_task_id ON task_steps(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_steps_status ON task_steps(status);

    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      kind TEXT NOT NULL,
      body_or_uri TEXT NOT NULL,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_task_id_created_at ON artifacts(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts(created_at DESC);

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS responsibilities (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      every_ms INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      task_title TEXT NOT NULL,
      task_prompt TEXT NOT NULL,
      task_success_criteria TEXT,
      dedupe_key TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_responsibilities_enabled ON responsibilities(enabled);
  `);

  // Migrate legacy jobs -> tasks once when local DB already exists.
  if (hasTable(db, 'jobs')) {
    db.exec(`
      INSERT OR IGNORE INTO tasks (
        id, type, title, prompt, success_criteria, payload_json, status, priority,
        attempt_count, max_attempts, next_run_at, parent_task_id, dedupe_key,
        lease_owner, lease_expires_at, last_error, created_at, updated_at
      )
      SELECT
        id,
        'legacy_job',
        'Legacy job',
        prompt,
        success_criteria,
        '{}',
        CASE status WHEN 'succeeded' THEN 'done' ELSE status END,
        3,
        attempt_count,
        max_attempts,
        NULL,
        NULL,
        NULL,
        lease_owner,
        lease_expires_at,
        last_error,
        created_at,
        updated_at
      FROM jobs;
    `);
  }

  if (hasTable(db, 'job_attempts')) {
    db.exec(`
      INSERT OR IGNORE INTO task_attempts (
        task_id, attempt_no, status, worker_exit_code, judge_decision,
        judge_explanation, output, started_at, finished_at
      )
      SELECT
        job_id,
        attempt_no,
        CASE status WHEN 'succeeded' THEN 'done' ELSE status END,
        worker_exit_code,
        judge_decision,
        judge_explanation,
        output,
        started_at,
        finished_at
      FROM job_attempts;
    `);
  }

  // Backward-compatible migration for older local DBs that used stdout/stderr columns.
  if (hasTable(db, 'task_attempts')) {
    if (!hasColumn(db, 'task_attempts', 'output')) {
      db.exec(`ALTER TABLE task_attempts ADD COLUMN output TEXT NOT NULL DEFAULT ''`);
    }

    const hasStdout = hasColumn(db, 'task_attempts', 'stdout');
    const hasStderr = hasColumn(db, 'task_attempts', 'stderr');
    if (hasStdout || hasStderr) {
      db.exec(`
        UPDATE task_attempts
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

  // Seed starter responsibility for first-time users.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO responsibilities (
      id, description, enabled, every_ms, task_type, task_title, task_prompt,
      task_success_criteria, dedupe_key, priority, last_run_at, created_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    'check_outstanding_tasks',
    'Periodically ask the agent to inspect open work and propose next actions.',
    60_000,
    'maintenance',
    'Review and progress outstanding tasks',
    'Check for outstanding tasks and progress the highest-priority actionable one. If nothing actionable exists, report idle.',
    null,
    'responsibility:check_outstanding_tasks',
    3,
    now,
    now
  );
}
