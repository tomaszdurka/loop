# loop

`loop` is a small orchestration tool with two layers:

1. `loop run`:
   - runs an agent prompt repeatedly (optionally with a success criteria judge)
   - stops on success or max iterations
2. queue system:
   - `loop gateway` exposes API for queuing/listing/leasing jobs
   - `loop worker` pulls queued jobs and executes them via `loop run-job` -> `loop run`

## Install

```bash
npm install
```

## Commands

- `loop gateway`
- `loop run "<prompt>" [--success "..."] [--provider codex|claude] [--max-iterations N] [--cwd "/path"]`
- `loop run-job <job-id> [--stream-job-logs]`
- `loop worker [--stream-job-logs]`

Equivalent via npm:

```bash
npm run loop -- <command...>
```

## Quick Flow

1. Start gateway (terminal A):

```bash
npm run loop -- gateway
```

2. Start worker (terminal B):

```bash
npm run loop -- worker --stream-job-logs
```

3. Queue a job (terminal C):

```bash
curl -sS -X POST http://localhost:7070/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Implement feature X",
    "success_criteria": "File src/x.ts exists and tests pass"
  }'
```

4. Check job status:

```bash
curl -sS http://localhost:7070/jobs/<job_id>
```

## REST API

- `POST /jobs` (`prompt` required, `success_criteria` optional)
- `GET /jobs/:id`
- `GET /jobs?status=queued|leased|running|succeeded|failed`
- `POST /jobs/lease`
- `POST /jobs/:id/lease`
- `POST /jobs/:id/heartbeat`
- `POST /jobs/:id/complete`

## Env Vars

Gateway:
- `QUEUE_DB_PATH` (default `./data/queue.sqlite`)
- `QUEUE_LEASE_TTL_MS` (default `120000`)
- `QUEUE_MAX_ATTEMPTS` (default `3`)
- `QUEUE_API_PORT` (default `7070`)

Worker:
- `WORKER_API_BASE_URL` (default `http://localhost:7070`)
- `WORKER_POLL_MS` (default `2000`)
- `WORKER_LEASE_TTL_MS` (default `120000`)
