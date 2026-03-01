import {
  asMessageEnvelope,
  isRecord,
  parseJsonObjectLine,
  toClaudeStreamEvent,
  type ClaudeMessageContentItem,
  type ClaudeResultEvent,
  type ClaudeStreamEvent
} from './claude-types.js';
import type { ModelEventKind, ModelOutputContentItem, ModelOutputEventPayload, ModelOutputType } from './model-event-types.js';
import type { PhaseSchema, ProviderExecutor, ProviderExecutorMessage } from './types.js';

type ClaudeStreamNormalized = {
  hasRenderableContent: boolean;
  eventKind: ModelEventKind;
  modelType: ModelOutputType;
  messageItems: ModelOutputContentItem[] | null;
  summary: string | null;
  resultMessage: string | null;
  terminalResultText: string | null;
};

function extractClaudeTerminalResultText(event: ClaudeStreamEvent | null): string | null {
  if (!event || event.type !== 'result') {
    return null;
  }
  const result = (event as ClaudeResultEvent).result;
  if (typeof result === 'string') {
    return result;
  }
  if (isRecord(result)) {
    return JSON.stringify(result);
  }
  return null;
}

function getStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeClaudeContentItem(item: ClaudeMessageContentItem): ModelOutputContentItem {
  if (item.type === 'text' && typeof item.text === 'string') {
    return { type: 'text', format: 'markdown', content: item.text };
  }
  if (item.type === 'tool_use') {
    return {
      type: 'tool_use',
      content: {
        tool_call_id: typeof item.id === 'string' ? item.id : null,
        tool_name: typeof item.name === 'string' ? item.name : null,
        input: item.input ?? null
      }
    };
  }
  if (item.type === 'tool_result' && typeof item.content === 'string') {
    return {
      type: 'tool_result',
      content: {
        tool_call_id: typeof item.tool_use_id === 'string' ? item.tool_use_id : null,
        content: item.content
      }
    };
  }
  return {
    type: 'unknown',
    content: item
  };
}

function extractClaudeMessageParts(event: ClaudeStreamEvent | null): {
  hasRenderableContent: boolean;
  eventKind: ModelEventKind;
  modelType: ModelOutputType;
  messageItems: ModelOutputContentItem[] | null;
  summary: string | null;
  resultMessage: string | null;
} {
  if (!event) {
    return {
      hasRenderableContent: false,
      eventKind: 'unknown',
      modelType: 'unknown',
      messageItems: null,
      summary: null,
      resultMessage: null
    };
  }

  if (event.type === 'assistant') {
    const envelope = asMessageEnvelope(event.message);
    if (!envelope) {
      return {
        hasRenderableContent: false,
        eventKind: 'assistant_message',
        modelType: 'message',
        messageItems: null,
        summary: null,
        resultMessage: null
      };
    }

    if (envelope.type === 'message') {
      const content = Array.isArray(envelope.content) ? envelope.content : [];
      const items = content
        .filter((entry): entry is ClaudeMessageContentItem => isRecord(entry) && typeof entry.type === 'string')
        .map((entry) => normalizeClaudeContentItem(entry));
      const hasToolUse = items.some((entry) => entry.type === 'tool_use');
      const hasText = items.some((entry) => entry.type === 'text');
      return {
        hasRenderableContent: items.length > 0,
        eventKind: 'assistant_message',
        modelType: hasToolUse && !hasText ? 'tool_use' : 'message',
        messageItems: items.length > 0 ? items : null,
        summary: null,
        resultMessage: null
      };
    }

    if (envelope.type === 'tool_result') {
      const resultText = getStringOrNull(envelope.result) ?? getStringOrNull(envelope.content);
      if (!resultText || resultText.trim().length === 0) {
        return {
          hasRenderableContent: false,
          eventKind: 'assistant_tool_result',
          modelType: 'message',
          messageItems: null,
          summary: null,
          resultMessage: null
        };
      }
      return {
        hasRenderableContent: true,
        eventKind: 'assistant_tool_result',
        modelType: 'message',
        messageItems: [{ type: 'tool_result', content: { tool_call_id: null, content: resultText } }],
        summary: null,
        resultMessage: null
      };
    }
  }

  if (event.type === 'result') {
    const summary = isRecord(event.result) && typeof event.result.summary === 'string'
      ? event.result.summary
      : null;
    const resultMessage = typeof event.result === 'string'
      ? event.result
      : isRecord(event.result)
        ? JSON.stringify(event.result)
        : null;
    if (event.subtype === 'success' && isRecord(event.result) && typeof event.result.summary === 'string') {
      return {
        hasRenderableContent: true,
        eventKind: 'result_success',
        modelType: 'result',
        messageItems: null,
        summary,
        resultMessage
      };
    }
    if (resultMessage && resultMessage.trim().length > 0) {
      return {
        hasRenderableContent: true,
        eventKind: 'result',
        modelType: 'result',
        messageItems: null,
        summary,
        resultMessage
      };
    }
  }

  if (event.type === 'system') {
    return {
      hasRenderableContent: false,
      eventKind: 'system',
      modelType: 'unknown',
      messageItems: null,
      summary: null,
      resultMessage: null
    };
  }
  if (event.type === 'user') {
    const message = event.message;
    if (isRecord(message) && Array.isArray(message.content)) {
      const items = message.content
        .filter((entry): entry is ClaudeMessageContentItem => isRecord(entry) && typeof entry.type === 'string')
        .map((entry) => normalizeClaudeContentItem(entry));
      const hasToolResult = items.some((entry) => entry.type === 'tool_result');
      return {
        hasRenderableContent: items.length > 0,
        eventKind: hasToolResult ? 'assistant_tool_result' : 'user',
        modelType: 'message',
        messageItems: items.length > 0 ? items : null,
        summary: null,
        resultMessage: null
      };
    }
    return {
      hasRenderableContent: false,
      eventKind: 'user',
      modelType: 'message',
      messageItems: null,
      summary: null,
      resultMessage: null
    };
  }

  return {
    hasRenderableContent: false,
    eventKind: 'unknown',
    modelType: 'unknown',
    messageItems: null,
    summary: null,
    resultMessage: null
  };
}

function normalizeClaudeStreamLine(parsedLine: Record<string, unknown> | null): ClaudeStreamNormalized {
  const event = toClaudeStreamEvent(parsedLine);
  if (!event) {
    return {
      hasRenderableContent: false,
      eventKind: 'unknown',
      modelType: 'unknown',
      messageItems: null,
      summary: null,
      resultMessage: null,
      terminalResultText: null
    };
  }

  const message = extractClaudeMessageParts(event);
  return {
    hasRenderableContent: message.hasRenderableContent,
    eventKind: message.eventKind,
    modelType: message.modelType,
    messageItems: message.messageItems,
    summary: message.summary,
    resultMessage: message.resultMessage,
    terminalResultText: extractClaudeTerminalResultText(event)
  };
}

function toModelPayload(normalized: ClaudeStreamNormalized): ModelOutputEventPayload {
  return {
    level: 'info',
    model_event_kind: normalized.eventKind,
    type: normalized.modelType,
    message: normalized.messageItems,
    summary: normalized.summary,
    result_message: normalized.resultMessage
  };
}

export class ClaudeExecutor implements ProviderExecutor {
  private terminalResultText: string | null = null;

  constructor(
    private readonly phaseName: string,
    private readonly schema: PhaseSchema,
    private readonly onMessage?: (message: ProviderExecutorMessage) => void
  ) {}

  buildCommand(prompt: string): { command: string; args: string[]; stdin: string | null } {
    const args = ['--dangerously-skip-permissions', '--print'];
    if (this.schema) {
      args.push('--output-format', 'json', '--json-schema', this.schema.schemaJson);
    } else {
      args.push('--verbose', '--output-format', 'stream-json');
    }
    return { command: 'claude', args, stdin: prompt };
  }

  isTerminalStream(): boolean {
    return this.phaseName === 'execute' && !this.schema;
  }

  handleOutputLine(line: string): void {
    const parsedLine = parseJsonObjectLine(line);
    if (!this.isTerminalStream()) {
      return;
    }

    const normalized = normalizeClaudeStreamLine(parsedLine);
    if (normalized.terminalResultText) {
      this.terminalResultText = normalized.terminalResultText;
    }
    if (!normalized.hasRenderableContent) {
      return;
    }

    this.onMessage?.({
      provider: 'claude',
      rawLine: line,
      parsedLine,
      modelOutputPayload: toModelPayload(normalized)
    });
  }

  getTerminalResultText(): string | null {
    return this.terminalResultText;
  }
}
