export type JsonObject = Record<string, unknown>;

export type ClaudeTopLevelType = 'system' | 'assistant' | 'user' | 'result';

export type ClaudeMessageType = 'message' | 'tool_result';

export type ClaudeContentType = 'text' | 'tool_use';

export type ClaudeMessageContentItem =
  | { type: 'text'; text: string; [key: string]: unknown }
  | { type: 'tool_use'; id?: unknown; name?: unknown; input?: unknown; [key: string]: unknown }
  | { type: 'tool_result'; tool_use_id?: unknown; content?: unknown; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type ClaudeMessageEnvelope = {
  type: ClaudeMessageType | string;
  content?: unknown;
  result?: unknown;
  [key: string]: unknown;
};

export type ClaudeSystemEvent = JsonObject & {
  type: 'system';
  subtype?: string;
};

export type ClaudeAssistantEvent = JsonObject & {
  type: 'assistant';
  message?: ClaudeMessageEnvelope | JsonObject;
};

export type ClaudeUserEvent = JsonObject & {
  type: 'user';
  message?: {
    role?: unknown;
    content?: unknown;
    [key: string]: unknown;
  } | unknown;
};

export type ClaudeResultEvent = JsonObject & {
  type: 'result';
  subtype?: string;
  result?: unknown;
};

export type ClaudeStreamEvent =
  | ClaudeSystemEvent
  | ClaudeAssistantEvent
  | ClaudeUserEvent
  | ClaudeResultEvent
  | (JsonObject & { type: string });

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonObjectLine(line: string): JsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toClaudeStreamEvent(value: JsonObject | null): ClaudeStreamEvent | null {
  if (!value) {
    return null;
  }
  if (typeof value.type !== 'string') {
    return null;
  }
  return value as ClaudeStreamEvent;
}

export function asMessageEnvelope(value: unknown): ClaudeMessageEnvelope | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  return value as ClaudeMessageEnvelope;
}
