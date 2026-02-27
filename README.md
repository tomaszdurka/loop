# loop

`loop` is a local orchestration tool with a durable task lifecycle.

It now runs on a unified model:
1. one canonical `tasks` queue (lease/retry/status)
2. internal `events` timeline
3. internal `state` checkpoints
4. recurring `responsibilities` that dispatch tasks on each tick

## Install

```bash
npm install
```

## Commands

- `loop gateway`
- `loop worker [--stream-job-logs]`
- `loop run "<prompt>" [--success "..."] [--provider codex|claude] [--max-iterations N] [--cwd "/path"]`
- `loop run-job <task-id> [--stream-job-logs]`
- `loop db:migrate`
- `loop tick`
- `loop status`
- `loop tasks:list [--status queued|leased|running|waiting_children|done|failed|blocked]`
- `loop tasks:create --prompt "..." [--type TYPE] [--title TITLE] [--priority 1..5] [--success "..."]`
- `loop tasks:create-child <parent-task-id> --prompt "..." [--type TYPE] [--title TITLE] [--priority 1..5] [--success "..."]`
- `loop events:tail [--limit N]`
- `loop responsibilities:list`
- `loop steps:list <task-id>`
- `loop artifacts:list [--task-id ID] [--limit N]`

Equivalent via npm:

```bash
npm run loop -- <command...>
```

## Quick Flow

1. Initialize schema:

```bash
npm run loop -- db:migrate
```

2. Start gateway (terminal A):

```bash
npm run loop -- gateway
```

3. Start worker (terminal B):

```bash
npm run loop -- worker --stream-job-logs
```

4. Run a heartbeat tick to dispatch due responsibilities:

```bash
npm run loop -- tick
```

5. Or create a task directly:

```bash
npm run loop -- tasks:create --prompt "Check outstanding tasks and progress one" --type maintenance --title "Progress outstanding tasks"
```

6. Check status:

```bash
npm run loop -- status
```

## REST API

Canonical task API:
- `POST /tasks`
- `POST /tasks/:id/children`
- `GET /tasks/:id/children`
- `GET /tasks/:id`
- `GET /tasks/:id/steps`
- `GET /tasks?status=queued|leased|running|waiting_children|done|failed|blocked`
- `POST /tasks/lease`
- `POST /tasks/:id/lease`
- `POST /tasks/:id/heartbeat`
- `POST /tasks/:id/complete`
- `GET /events?limit=N`
- `GET /artifacts?task_id=<id>&limit=N`
- `GET /responsibilities`
- `POST /tick`

Backward compatibility aliases exist for `/jobs*` routes.

## Optional step markers for checkpointing

If your task output includes markers in this format, they are stored in `task_steps`:

```text
STEP[fetch_emails]: DONE idempotency=inbox-sync-2026-02-27 note=Fetched 12 emails
STEP[reply_draft]: FAILED idempotency=reply-abc123 note=Model refused
```

## Parent-child tasks (V2)

- Create a parent task with `tasks:create`.
- Create durable child tasks with `tasks:create-child <parent-task-id> ...` or `POST /tasks/:id/children`.
- Parent transitions to `waiting_children` while children are active.
- When all children finish:
  - parent goes to `queued` if all children succeeded
  - parent goes to `blocked` if any child failed/blocked

## Env Vars

Gateway:
- `QUEUE_DB_PATH` (default `./data/queue.sqlite`)
- `QUEUE_LEASE_TTL_MS` (default `120000`)
- `QUEUE_MAX_ATTEMPTS` (default `3`)
- `QUEUE_API_PORT` (default `7070`)
- `QUEUE_MAX_CHILD_DEPTH` (default `1`)
- `QUEUE_MAX_CHILDREN_PER_TASK` (default `5`)

Worker:
- `WORKER_API_BASE_URL` (default `http://localhost:7070`)
- `WORKER_POLL_MS` (default `2000`)
- `WORKER_LEASE_TTL_MS` (default `120000`)
