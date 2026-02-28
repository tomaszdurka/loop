# agentic-loop (vNext)

Local durable queue with a phase-based LLM worker pipeline.

Core lifecycle:
1. queue task
2. lease task
3. run phases (interpret -> plan -> policy -> execute -> verify -> report)
4. complete attempt

All system prompts are Markdown files in `prompts/system/`.

## Install

```bash
npm install
```

## Commands

- `loop gateway`
- `loop worker [--provider codex|claude] [--stream-job-logs]`
- `loop db:migrate`
- `loop status`
- `loop tasks:list [--status queued|leased|running|done|failed|blocked]`
- `loop tasks:create --prompt "..." [--type TYPE] [--title TITLE] [--priority 1..5] [--success "..."] [--mode auto|lean|full]`
- `loop events:tail [--limit N] [--task-id ID]`
- `loop run "<prompt>" [--success "..."] [--provider codex|claude] [--max-iterations N] [--cwd "/path"]`

## Quick Start

1. Initialize DB:

```bash
npm run loop -- db:migrate
```

2. Start gateway:

```bash
npm run loop -- gateway
```

3. Start worker:

```bash
npm run loop -- worker --provider claude --stream-job-logs
```

4. Queue task (`/tasks/queue` returns task id):

```bash
curl -sS -X POST http://localhost:7070/tasks/queue \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build a landing page for dog lovers","success_criteria":"A landing page file exists and is wired into project","mode":"auto"}' \
| jq
```

5. Run and wait with NDJSON stream (`/tasks/run`):

```bash
curl -sS -N -X POST http://localhost:7070/tasks/run \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt":"what are the figurines in 17th minifigurines lego series",
    "mode":"lean"
  }' \
| jq -RC --unbuffered 'fromjson? | select(.) | {type, phase, payload}'
```

6. Inspect:

```bash
npm run loop -- status
npm run loop -- tasks:list
npm run loop -- events:tail --limit 50
```

## REST API

- `POST /tasks/queue` (queue task, returns `task_id`)
- `POST /tasks/run` (run and stream NDJSON envelopes; first event is immediate task acceptance)
- `GET /tasks`
- `GET /tasks/:id`
- `GET /tasks/:id/attempts`
- `GET /tasks/:id/events?limit=<n>`
- `POST /tasks/lease`
- `POST /tasks/:id/heartbeat`
- `POST /tasks/:id/events`
- `POST /tasks/:id/complete`
- `GET /events?task_id=<id>&limit=<n>`
- `GET /state/:key`
- `POST /state/:key`

`POST /tasks/queue` and `POST /tasks/run` accept optional `mode`:
- `auto` (default): tiny classifier decides `lean` or `full`
- `lean`: execute -> verify -> report
- `full`: interpret -> plan -> policy -> execute -> verify -> report

## Prompts

- `prompts/system/00_executor_base.md`
- `prompts/system/05_mode_classifier.md`
- `prompts/system/10_interpret.md`
- `prompts/system/20_plan.md`
- `prompts/system/30_execution_policy.md`
- `prompts/system/40_verify.md`
- `prompts/system/50_report.md`

## Env Vars

Gateway:
- `QUEUE_DB_PATH` (default `./data/queue-vnext.sqlite`)
- `QUEUE_LEASE_TTL_MS` (default `120000`)
- `QUEUE_MAX_ATTEMPTS` (default `3`)
- `QUEUE_API_PORT` (default `7070`)

Worker:
- `WORKER_API_BASE_URL` (default `http://localhost:7070`)
- `WORKER_POLL_MS` (default `2000`)
- `WORKER_LEASE_TTL_MS` (default `120000`)
- `WORKER_PHASE_TIMEOUT_MS` (default `600000`)
