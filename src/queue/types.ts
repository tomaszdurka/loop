export type TaskStatus = 'queued' | 'leased' | 'running' | 'done' | 'failed' | 'blocked';
export type TaskMode = 'auto' | 'lean' | 'full';

export type TaskRow = {
  id: string;
  type: string;
  title: string;
  prompt: string;
  success_criteria: string | null;
  task_request_json: string;
  status: TaskStatus;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskAttemptStatus = 'running' | 'done' | 'failed' | 'blocked';

export type TaskAttemptRow = {
  id: number;
  task_id: string;
  attempt_no: number;
  lease_owner: string;
  lease_expires_at: string;
  status: TaskAttemptStatus;
  phase: string;
  output_json: string;
  started_at: string;
  finished_at: string | null;
};

export type EventRow = {
  id: number;
  task_id: string | null;
  attempt_id: number | null;
  phase: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  data_json: string;
  created_at: string;
};

export type StateRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

export type CreateTaskInput = {
  type?: string;
  title?: string;
  prompt: string;
  successCriteria?: string;
  metadata?: Record<string, unknown>;
  mode?: TaskMode;
  priority?: number;
  maxAttempts?: number;
};

export type CompleteAttemptInput = {
  workerExitCode: number | null;
  outputJson: Record<string, unknown>;
  finalPhase: string;
  succeeded: boolean;
  blocked: boolean;
  errorMessage: string | null;
  finishedAt: string;
};
