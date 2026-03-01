# Codex Stream Types

Canonical TypeScript source: [`codex-types.ts`](./codex-types.ts)

Observed top-level `type` values from `codex exec --json`:
- `thread.started`
- `turn.started`
- `item.started`
- `item.completed`
- `turn.completed`

Observed `item.type` values:
- `reasoning`
- `web_search`
- `agent_message`

Typed normalized item shapes are constrained to:
- `reasoning` (`id`, `text`)
- `agent_message` (`id`, `text`)
- `web_search` (`id`, `query`, optional structured `action`)
- fallback `unknown_item` (`id`, `type`, `raw`)

Normalization logic location:
- [`codex-executor.ts`](./codex-executor.ts)
