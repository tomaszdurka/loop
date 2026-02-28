import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecuteRunner, ModelClient, RunStreamer, ToolExecutor, type StreamEnvelope } from './execute-runner.js';

test('execute runner emits replay-safe NDJSON envelopes', async () => {
  const envelopes: StreamEnvelope[] = [];

  const streamer = new RunStreamer('run_001', 'execute', async (envelope) => {
    envelopes.push(envelope);
  });

  let turn = 0;
  const model = new ModelClient(async () => {
    turn += 1;
    if (turn === 1) {
      return JSON.stringify({
        decision: 'run',
        reason: 'need data',
        actions: [
          {
            tool: 'web_search',
            step_id: 'S1',
            arguments: { q: 'lego series 16 list' }
          }
        ]
      });
    }
    return JSON.stringify({ decision: 'stop_succeeded', reason: 'enough data', actions: [] });
  });

  const tools = new ToolExecutor({
    web_search: async (args) => ({
      sources: [{ ref: 'turn0search0' }],
      query: args.q ?? ''
    })
  });

  const runner = new ExecuteRunner(streamer, model, tools, { maxTurns: 5, maxActions: 5 });
  const result = await runner.run({ plan: { steps: [] }, execution_policy: {} });

  assert.equal(result.status, 'succeeded');

  for (let i = 1; i < envelopes.length; i += 1) {
    assert.ok(envelopes[i].sequence > envelopes[i - 1].sequence, 'sequence must strictly increase');
  }

  const actionIds = envelopes
    .filter((e) => e.type === 'action')
    .map((e) => String(e.payload.action_id));
  const toolResultActionIds = envelopes
    .filter((e) => e.type === 'tool_result')
    .map((e) => String(e.payload.action_id));

  for (const actionId of actionIds) {
    const count = toolResultActionIds.filter((id) => id === actionId).length;
    assert.equal(count, 1, `action_id ${actionId} must have exactly one tool_result`);
  }

  const terminal = envelopes.filter((e) => e.type === 'state_change').at(-1);
  assert.ok(terminal, 'terminal state_change must exist');
  assert.equal(terminal?.payload.to, 'succeeded');

  const artifacts = envelopes.filter((e) => e.type === 'artifact');
  assert.ok(artifacts.length > 0, 'artifact must exist on succeeded');
});
