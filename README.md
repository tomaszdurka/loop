# agentic-loop

Minimal TypeScript CLI loop around `codex exec`.

## Install

```bash
npm install
```

## Run

```bash
npm run loop -- --prompt "Implement X" --success "All tests pass and file Y exists"
```

Optional flags:

- `--max-iterations 5`
- `--provider codex|claude` (default `codex`)

The script:

1. Runs a worker `codex exec`.
2. Runs a separate judge `codex exec` that inspects the workspace and returns `YES:` or `NO:`.
3. Retries with prior judge feedback until success or max iterations.

Both worker and judge runs use:

- `--dangerously-bypass-approvals-and-sandbox`
- `--skip-git-repo-check`

## Queue Service

This project also includes a local queue gateway + worker backed by SQLite.

### Start API

```bash
npm run queue:api
```

Default: `http://localhost:7070`

### Start Worker

```bash
npm run queue:worker
```

With per-run live logs streamed from `agentic-loop`:

```bash
npm run queue:worker -- --stream-job-logs
```

### REST API

- `POST /jobs`
  - Body:
    - `prompt` (required)
    - `success_criteria` (optional; if present, worker runs judge step)
- `GET /jobs/:id`
- `GET /jobs?status=queued|leased|running|succeeded|failed`
- `POST /jobs/lease` (worker endpoint)
- `POST /jobs/:id/heartbeat` (worker endpoint)
- `POST /jobs/:id/complete` (worker endpoint)

### Gateway env vars

- `QUEUE_DB_PATH` (default `./data/queue.sqlite`)
- `QUEUE_LEASE_TTL_MS` (default `120000`)
- `QUEUE_MAX_ATTEMPTS` (default `3`)
- `QUEUE_API_PORT` (default `7070`)

### Worker env vars

- `WORKER_API_BASE_URL` (default `http://localhost:7070`)
- `WORKER_POLL_MS` (default `2000`)
- `WORKER_LEASE_TTL_MS` (default `120000`)
