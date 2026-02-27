export type TaskStatus = 'queued' | 'leased' | 'running' | 'waiting_children' | 'done' | 'failed' | 'blocked';

export type JudgeDecisionValue = 'YES' | 'NO' | null;

export type TaskRow = {
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
};

export type TaskAttemptRow = {
  id: number;
  task_id: string;
  attempt_no: number;
  status: 'running' | 'done' | 'failed';
  worker_exit_code: number | null;
  judge_decision: JudgeDecisionValue;
  judge_explanation: string | null;
  output: string;
  started_at: string;
  finished_at: string | null;
};

export type EventRow = {
  id: number;
  task_id: string | null;
  kind: string;
  data_json: string;
  created_at: string;
};

export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed';

export type TaskStepRow = {
  id: number;
  task_id: string;
  step_key: string;
  status: TaskStepStatus;
  idempotency_key: string | null;
  result_json: string;
  updated_at: string;
};

export type ArtifactRow = {
  id: number;
  task_id: string | null;
  kind: 'text' | 'json' | 'file_ref';
  body_or_uri: string;
  meta_json: string;
  created_at: string;
};

export type StateRow = {
  key: string;
  value_json: string;
  updated_at: string;
};

export type ResponsibilityRow = {
  id: string;
  description: string;
  enabled: 0 | 1;
  every_ms: number;
  task_type: string;
  task_title: string;
  task_prompt: string;
  task_success_criteria: string | null;
  dedupe_key: string | null;
  priority: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateTaskInput = {
  type?: string;
  title?: string;
  prompt: string;
  successCriteria?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  nextRunAt?: string;
  parentTaskId?: string;
  dedupeKey?: string;
};

export type CompleteAttemptInput = {
  workerExitCode: number | null;
  judgeDecision: JudgeDecisionValue;
  judgeExplanation: string | null;
  output: string;
  succeeded: boolean;
  errorMessage: string | null;
  finishedAt: string;
};

export type UpsertTaskStepInput = {
  stepKey: string;
  status: TaskStepStatus;
  idempotencyKey?: string | null;
  result?: Record<string, unknown>;
};

export type CreateArtifactInput = {
  taskId?: string | null;
  kind: 'text' | 'json' | 'file_ref';
  bodyOrUri: string;
  meta?: Record<string, unknown>;
};
