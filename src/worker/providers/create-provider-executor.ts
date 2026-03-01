import { ClaudeExecutor } from './claude-executor.js';
import { CodexExecutor } from './codex-executor.js';
import type { PhaseSchema, ProviderExecutor, ProviderExecutorMessage } from './types.js';

export function createProviderExecutor(
  provider: 'claude' | 'codex',
  phaseName: string,
  schema: PhaseSchema,
  onMessage?: (message: ProviderExecutorMessage) => void
): ProviderExecutor {
  if (provider === 'claude') {
    return new ClaudeExecutor(phaseName, schema, onMessage);
  }
  return new CodexExecutor(phaseName, schema, onMessage);
}
