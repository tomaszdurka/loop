import {
  parseCodexItem,
  parseCodexJsonObjectLine,
  toCodexStreamEvent,
  type CodexItem,
  type CodexUnknownItem
} from './codex-types.js';
import type { ModelEventKind, ModelOutputContentItem, ModelOutputEventPayload } from './model-event-types.js';
import type { PhaseSchema, ProviderExecutor, ProviderExecutorMessage } from './types.js';

function inferToolInput(item: CodexItem): unknown {
  if (isUnknownItem(item)) {
    return item.raw;
  }
  if (item.type === 'web_search') {
    return item.action ?? { query: item.query };
  }
  if (item.type === 'reasoning' || item.type === 'agent_message') {
    return { text: item.text };
  }
  return item;
}

function isUnknownItem(item: CodexItem): item is CodexUnknownItem {
  return 'raw' in item;
}

function buildItemPayload(item: CodexItem): ModelOutputEventPayload | null {
  const itemType = item.type;
  const asToolUseItem = (content: unknown): ModelOutputContentItem => ({
    type: 'tool_use',
    content: {
      tool_call_id: item.id,
      tool_name: itemType,
      input: content
    }
  });

  if (isUnknownItem(item)) {
    return {
      level: 'info',
      model_event_kind: 'assistant_message',
      type: 'tool_use',
      message: [asToolUseItem(item.raw)],
      summary: null,
      result_message: null
    };
  }

  if (itemType === 'agent_message') {
    return {
      level: 'info',
      model_event_kind: 'assistant_message',
      type: 'message',
      message: [{ type: 'text', format: 'markdown', content: item.text }],
      summary: null,
      result_message: null
    };
  }

  if (itemType === 'reasoning') {
    return {
      level: 'info',
      model_event_kind: 'assistant_message',
      type: 'message',
      message: [{ type: 'text', format: 'text', content: item.text }],
      summary: null,
      result_message: null
    };
  }

  return {
    level: 'info',
    model_event_kind: 'assistant_message',
    type: 'tool_use',
    message: [asToolUseItem(inferToolInput(item))],
    summary: null,
    result_message: null
  };
}

function buildModelOutputPayload(rawLine: string, parsedLine: Record<string, unknown> | null): ModelOutputEventPayload | null {
  const event = toCodexStreamEvent(parsedLine);
  if (event) {
    if (event.type === 'item.started' || event.type === 'item.completed') {
      const parsedItem = parseCodexItem(event.item);
      if (parsedItem) {
        return buildItemPayload(parsedItem);
      }
      return null;
    }
    return null;
  }

  return {
    level: 'info',
    model_event_kind: 'unknown' as ModelEventKind,
    type: 'message',
    message: [{ type: 'text', format: 'text', content: rawLine }],
    summary: null,
    result_message: null
  };
}

export class CodexExecutor implements ProviderExecutor {
  constructor(
    _phaseName: string,
    private readonly schema: PhaseSchema,
    private readonly onMessage?: (message: ProviderExecutorMessage) => void
  ) {}

  buildCommand(prompt: string): { command: string; args: string[]; stdin: string | null } {
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
    if (this.schema) {
      args.push('--output-schema', this.schema.schemaPath);
    }
    args.push(prompt);
    return { command: 'codex', args, stdin: null };
  }

  isTerminalStream(): boolean {
    return false;
  }

  handleOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const parsedLine = parseCodexJsonObjectLine(line);
    const payload = buildModelOutputPayload(line, parsedLine);
    if (!payload) {
      return;
    }
    this.onMessage?.({
      provider: 'codex',
      rawLine: line,
      parsedLine,
      modelOutputPayload: payload
    });
  }

  getTerminalResultText(): string | null {
    return null;
  }
}
