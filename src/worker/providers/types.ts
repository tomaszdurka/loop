import type { ModelOutputEventPayload } from './model-event-types.js';

export type PhaseSchema = { schemaJson: string; schemaPath: string } | null;

export type ProviderExecutorMessage = {
  provider: 'claude' | 'codex';
  rawLine: string;
  parsedLine: Record<string, unknown> | null;
  modelOutputPayload: ModelOutputEventPayload | null;
};

export interface ProviderExecutor {
  buildCommand(prompt: string): { command: string; args: string[]; stdin: string | null };
  handleOutputLine(line: string): void;
  isTerminalStream(): boolean;
  getTerminalResultText(): string | null;
}
