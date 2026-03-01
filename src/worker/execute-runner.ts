import { randomUUID } from 'node:crypto';

export type StreamType = 'state_change' | 'event' | 'action' | 'tool_result' | 'artifact' | 'error';
export type StreamProducer = 'system' | 'model';

export type StreamEnvelope = {
  run_id: string;
  sequence: number;
  timestamp: string;
  type: StreamType;
  phase: string;
  producer: StreamProducer;
  payload: Record<string, unknown>;
};

export type EmitFn = (envelope: StreamEnvelope) => Promise<void> | void;
type SequenceRef = { value: number };

export class RunStreamer {
  private sequence = 0;

  constructor(
    private readonly runId: string,
    private readonly phase: string,
    private readonly emitFn: EmitFn,
    private readonly sequenceRef?: SequenceRef
  ) {}

  private async emit(type: StreamType, producer: StreamProducer, payload: Record<string, unknown>): Promise<StreamEnvelope> {
    if (this.sequenceRef) {
      this.sequenceRef.value += 1;
      this.sequence = this.sequenceRef.value;
    } else {
      this.sequence += 1;
    }
    const envelope: StreamEnvelope = {
      run_id: this.runId,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      type,
      phase: this.phase,
      producer,
      payload
    };
    await this.emitFn(envelope);
    return envelope;
  }

  emitEvent(payload: Record<string, unknown>): Promise<StreamEnvelope> {
    return this.emit('event', 'system', payload);
  }

  emitModelOutput(payload: Record<string, unknown>): Promise<StreamEnvelope> {
    return this.emit('event', 'model', payload);
  }

  emitAction(payload: Record<string, unknown>, producer: StreamProducer = 'model'): Promise<StreamEnvelope> {
    return this.emit('action', producer, payload);
  }

  emitToolResult(payload: Record<string, unknown>): Promise<StreamEnvelope> {
    return this.emit('tool_result', 'system', payload);
  }

  emitArtifact(payload: Record<string, unknown>, producer: StreamProducer = 'system'): Promise<StreamEnvelope> {
    return this.emit('artifact', producer, payload);
  }

  emitStateChange(payload: Record<string, unknown>): Promise<StreamEnvelope> {
    return this.emit('state_change', 'system', payload);
  }

  emitError(payload: Record<string, unknown>): Promise<StreamEnvelope> {
    return this.emit('error', 'system', payload);
  }
}

export type ExecuteDecision = {
  decision: 'run' | 'stop_succeeded' | 'stop_failed';
  reason: string;
  actions: Array<{
    tool: string;
    arguments: Record<string, unknown>;
    step_id: string;
  }>;
};

export class ModelClient {
  constructor(private readonly decideFn: (input: Record<string, unknown>) => Promise<string>) {}

  static parseDecision(raw: string): ExecuteDecision {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model decision must be a JSON object');
    }

    const obj = parsed as Record<string, unknown>;
    const decision = obj.decision;
    const reason = obj.reason;
    const actions = obj.actions;

    if (decision !== 'run' && decision !== 'stop_succeeded' && decision !== 'stop_failed') {
      throw new Error('Invalid decision');
    }
    if (typeof reason !== 'string') {
      throw new Error('Invalid reason');
    }
    if (!Array.isArray(actions)) {
      throw new Error('Invalid actions');
    }

    const normalizedActions = actions.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Invalid action entry');
      }
      const action = item as Record<string, unknown>;
      if (typeof action.tool !== 'string' || typeof action.step_id !== 'string') {
        throw new Error('Invalid action fields');
      }
      if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) {
        throw new Error('Invalid action arguments');
      }
      return {
        tool: action.tool,
        step_id: action.step_id,
        arguments: action.arguments as Record<string, unknown>
      };
    });

    return { decision, reason, actions: normalizedActions };
  }

  async decide(input: Record<string, unknown>): Promise<ExecuteDecision> {
    const raw = await this.decideFn(input);
    return ModelClient.parseDecision(raw);
  }
}

export type ToolResult = {
  ok: boolean;
  result: Record<string, unknown>;
  truncated: boolean;
};

export class ToolExecutor {
  private readonly results = new Map<string, ToolResult>();

  constructor(
    private readonly tools: Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>,
    private readonly truncateAt = 8000
  ) {}

  async execute(input: {
    action_id: string;
    tool: string;
    arguments: Record<string, unknown>;
    idempotency_key: string;
  }): Promise<ToolResult> {
    const existing = this.results.get(input.action_id);
    if (existing) {
      return existing;
    }

    const fn = this.tools[input.tool];
    if (!fn) {
      const result: ToolResult = {
        ok: false,
        result: { error: `Unknown tool: ${input.tool}` },
        truncated: false
      };
      this.results.set(input.action_id, result);
      return result;
    }

    try {
      const raw = await fn(input.arguments);
      let result = raw;
      let truncated = false;
      const serialized = JSON.stringify(raw);
      if (serialized.length > this.truncateAt) {
        truncated = true;
        result = {
          truncated: true,
          preview: serialized.slice(0, this.truncateAt),
          full_ref: `action:${input.action_id}:full_result`
        };
      }

      const toolResult: ToolResult = { ok: true, result, truncated };
      this.results.set(input.action_id, toolResult);
      return toolResult;
    } catch (error) {
      const toolResult: ToolResult = {
        ok: false,
        result: { error: error instanceof Error ? error.message : String(error) },
        truncated: false
      };
      this.results.set(input.action_id, toolResult);
      return toolResult;
    }
  }
}

export class ExecuteRunner {
  constructor(
    private readonly streamer: RunStreamer,
    private readonly model: ModelClient,
    private readonly tools: ToolExecutor,
    private readonly limits: { maxTurns: number; maxActions: number }
  ) {}

  async run(input: {
    plan: Record<string, unknown>;
    execution_policy: Record<string, unknown>;
  }): Promise<{ status: 'succeeded' | 'failed' | 'canceled'; artifacts: Array<Record<string, unknown>> }> {
    const artifacts: Array<Record<string, unknown>> = [];
    const toolResults: Array<Record<string, unknown>> = [];

    let actionCount = 0;

    await this.streamer.emitStateChange({ from: 'pending', to: 'running' });
    await this.streamer.emitEvent({ level: 'info', message: 'Execute loop started', data: { max_turns: this.limits.maxTurns } });

    try {
      for (let turn = 1; turn <= this.limits.maxTurns; turn += 1) {
        await this.streamer.emitEvent({ level: 'info', message: 'Requesting next action from model', data: { turn } });

        const decision = await this.model.decide({
          turn,
          plan: input.plan,
          execution_policy: input.execution_policy,
          tool_results: toolResults
        });

        if (decision.decision === 'stop_succeeded') {
          const artifact = {
            name: 'result',
            format: 'json',
            content: {
              summary: decision.reason,
              tool_results: toolResults
            }
          };
          artifacts.push(artifact);
          await this.streamer.emitArtifact(artifact, 'system');
          await this.streamer.emitStateChange({ from: 'running', to: 'succeeded' });
          return { status: 'succeeded', artifacts };
        }

        if (decision.decision === 'stop_failed') {
          await this.streamer.emitError({ code: 'MODEL_STOP_FAILED', message: decision.reason });
          await this.streamer.emitStateChange({ from: 'running', to: 'failed' });
          return { status: 'failed', artifacts };
        }

        for (const action of decision.actions) {
          actionCount += 1;
          if (actionCount > this.limits.maxActions) {
            await this.streamer.emitError({ code: 'MAX_ACTIONS_EXCEEDED', message: 'max actions reached' });
            await this.streamer.emitStateChange({ from: 'running', to: 'failed' });
            return { status: 'failed', artifacts };
          }

          const actionId = `a_${randomUUID()}`;
          const idempotencyKey = `ik:${action.step_id}:${action.tool}:${actionId}`;

          await this.streamer.emitAction({
            action_id: actionId,
            step_id: action.step_id,
            tool: action.tool,
            arguments: action.arguments,
            idempotency_key: idempotencyKey
          });

          const toolResult = await this.tools.execute({
            action_id: actionId,
            tool: action.tool,
            arguments: action.arguments,
            idempotency_key: idempotencyKey
          });

          const resultPayload = {
            action_id: actionId,
            step_id: action.step_id,
            tool: action.tool,
            ok: toolResult.ok,
            result: toolResult.result,
            truncated: toolResult.truncated
          };

          toolResults.push(resultPayload);
          await this.streamer.emitToolResult(resultPayload);
        }
      }

      await this.streamer.emitError({ code: 'MAX_TURNS_EXCEEDED', message: 'max turns reached' });
      await this.streamer.emitStateChange({ from: 'running', to: 'failed' });
      return { status: 'failed', artifacts };
    } catch (error) {
      await this.streamer.emitError({
        code: 'EXECUTE_EXCEPTION',
        message: error instanceof Error ? error.message : String(error)
      });
      await this.streamer.emitStateChange({ from: 'running', to: 'failed' });
      return { status: 'failed', artifacts };
    }
  }
}
