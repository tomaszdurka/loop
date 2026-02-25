export type JobStatus = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed';

export type JudgeDecisionValue = 'YES' | 'NO' | null;

export type JobRow = {
  id: string;
  prompt: string;
  success_criteria: string | null;
  status: JobStatus;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type JobAttemptRow = {
  id: number;
  job_id: string;
  attempt_no: number;
  status: 'running' | 'succeeded' | 'failed';
  worker_exit_code: number | null;
  judge_decision: JudgeDecisionValue;
  judge_explanation: string | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at: string | null;
};

export type CreateJobInput = {
  prompt: string;
  successCriteria?: string;
};

export type CompleteAttemptInput = {
  workerExitCode: number | null;
  judgeDecision: JudgeDecisionValue;
  judgeExplanation: string | null;
  stdout: string;
  stderr: string;
  succeeded: boolean;
  errorMessage: string | null;
  finishedAt: string;
};
