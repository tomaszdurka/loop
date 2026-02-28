# User Guide (vNext)

## What this does

This service runs durable queued tasks with an LLM phase pipeline.
You submit tasks, worker leases them, runs phases, verifies result, and stores events.

## What to edit

Adjust behavior by editing prompt files in `prompts/system/`.
No TypeScript prompt text changes are required for normal tuning.

## Basic workflow

1. Start gateway:

```bash
npm run loop -- gateway
```

2. Start worker:

```bash
npm run loop -- worker --provider codex --stream-job-logs
```

3. Create task:

```bash
curl -sS -X POST http://localhost:7070/tasks \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Build website for dog lovers","success_criteria":"Landing page implemented"}'
```

4. Check status/events:

```bash
npm run loop -- status
npm run loop -- tasks:list
npm run loop -- events:tail --limit 100
```

## Notes

- `run_state` stores idempotency records and similar durable runtime memory.
- If interpret phase requires missing data, task can end in `blocked`.
