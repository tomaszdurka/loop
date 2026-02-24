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

The script:

1. Runs a worker `codex exec`.
2. Runs a separate judge `codex exec` that inspects the workspace and returns `YES:` or `NO:`.
3. Retries with prior judge feedback until success or max iterations.

Both worker and judge runs use:

- `--dangerously-bypass-approvals-and-sandbox`
- `--skip-git-repo-check`
