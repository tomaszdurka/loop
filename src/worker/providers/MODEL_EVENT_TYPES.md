# Model Event Types

Canonical TypeScript source: [`model-event-types.ts`](./model-event-types.ts)

Normalized model payload used by stream envelopes where `producer="model"`:
- `level`
- `model_event_kind`
- `type` (`message | tool_use | result | unknown`)
- `message` (`[{ type, content, ... }]` or `null`)
- `summary` (`string | null`)
- `result_message` (`string | null`)

Current `model_event_kind` values:
- `assistant_message`
- `assistant_tool_result`
- `result_success`
- `result`
- `system`
- `user`
- `unknown`

`message[]` item variants:
- `text` (`content`, optional `format`)
- `tool_use` (`content: { tool_name, tool_call_id, input }`)
- `tool_result` (`content: { tool_call_id, content }`)
- `unknown` (`content: unknown`)

Normalization logic location:
- [`claude-executor.ts`](./claude-executor.ts)
- [`codex-executor.ts`](./codex-executor.ts)
