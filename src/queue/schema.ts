import type Database from 'better-sqlite3';

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'generic',
      title TEXT NOT NULL DEFAULT 'Untitled task',
      prompt TEXT NOT NULL,
      success_criteria TEXT,
      task_request_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 3,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      lease_owner TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_priority_created_at ON tasks(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_lease_expires_at ON tasks(lease_expires_at);

    CREATE TABLE IF NOT EXISTS task_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      output_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, attempt_no)
    );

    CREATE INDEX IF NOT EXISTS idx_task_attempts_task_id_attempt_no ON task_attempts(task_id, attempt_no);

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      attempt_id INTEGER,
      phase TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY(attempt_id) REFERENCES task_attempts(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_task_id_created_at ON events(task_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS run_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
