# Claude Stream Types

Canonical TypeScript source: [`claude-types.ts`](./claude-types.ts)

Known top-level `type` values:
- `system`
- `assistant`
- `user`
- `result`

For `type: "assistant"`:
- `message.type: "message"`: array-style `message.content[]` items.
- `message.type: "tool_result"`: plain textual result (`message.result` or `message.content`).

For `type: "user"`:
- `message.content[]` can include `type: "tool_result"` entries (with `tool_use_id` and `content`).

For `type: "result"`:
- `subtype: "success"` is treated specially by executor normalization.
- `result.summary` is used as main text when present.

Parsing logic location:
- [`claude-executor.ts`](./claude-executor.ts)
