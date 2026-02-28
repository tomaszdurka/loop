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

4. Create task:

```bash
curl -sS -X POST http://localhost:7070/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build a landing page for dog lovers","success_criteria":"A landing page file exists and is wired into project","mode":"auto"}'
```

5. Inspect:

```bash
npm run loop -- status
npm run loop -- tasks:list
npm run loop -- events:tail --limit 50
```

## REST API

- `POST /tasks`
- `GET /tasks`
- `GET /tasks/:id`
- `POST /tasks/lease`
- `POST /tasks/:id/heartbeat`
- `POST /tasks/:id/events`
- `POST /tasks/:id/complete`
- `GET /events?task_id=<id>&limit=<n>`
- `GET /state/:key`
- `POST /state/:key`

## Streaming Run-Wait (NDJSON)

`POST /tasks/run-wait` streams NDJSON envelopes event-by-event.

Example with `jq` parsing each line (`fromjson`) and showing multiline indented output:

```bash
curl -sS -N -X POST http://localhost:7070/tasks/run-wait \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"what are the figurines in 17th minifigurines lego series","mode":"lean"}' \
| jq -RC --unbuffered 'fromjson? | select(.)'
```

`POST /tasks` accepts optional `mode`:
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
