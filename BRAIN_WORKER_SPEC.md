# Brain Worker Spec (vNext)

## Intent

Provide a minimal durable task runtime with a clear LLM phase pipeline.

## Core entities

- `tasks`: queued work and lifecycle status
- `task_attempts`: per-attempt phase/output envelope
- `events`: structured run timeline
- `run_state`: persistent key-value state (idempotency/dedupe/checkpoints)

## Runtime phases

1. `intake` (system)
2. `preflight/lease` (system)
3. `interpret` (LLM, prompt file)
4. `plan` (LLM, prompt file)
5. `execution_policy` (LLM, prompt file + system idempotency key)
6. `execute` (LLM-driven execution summary)
7. `verify` (LLM)
8. `report` (LLM)
9. `commit` (system complete attempt)

## Prompt files

- `prompts/system/00_executor_base.md`
- `prompts/system/10_interpret.md`
- `prompts/system/20_plan.md`
- `prompts/system/30_execution_policy.md`
- `prompts/system/40_verify.md`
- `prompts/system/50_report.md`

## API

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/lease`
- `POST /tasks/:id/heartbeat`
- `POST /tasks/:id/events`
- `POST /tasks/:id/complete`
- `GET /events`
- `GET /state/:key`
- `POST /state/:key`

## Non-goals

- Responsibilities / periodic dispatcher
- Parent-child tasks
- Jobs alias routes
- Legacy compatibility
