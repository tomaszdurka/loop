export type CodexJsonObject = Record<string, unknown>;

export type CodexEventType =
  | 'thread.started'
  | 'turn.started'
  | 'item.started'
  | 'item.completed'
  | 'turn.completed'
  | 'turn.failed'
  | string;

export type CodexItemType =
  | 'reasoning'
  | 'agent_message'
  | 'web_search'
  | 'bash'
  | 'read'
  | 'write'
  | string;

export type CodexSearchAction = {
  type: string;
  query?: string;
  queries?: string[];
};

export type CodexReasoningItem = {
  id: string;
  type: 'reasoning';
  text: string;
};

export type CodexAgentMessageItem = {
  id: string;
  type: 'agent_message';
  text: string;
};

export type CodexWebSearchItem = {
  id: string;
  type: 'web_search';
  query: string;
  action?: CodexSearchAction;
};

export type CodexUnknownItem = {
  id: string;
  type: string;
  raw: CodexJsonObject;
};

export type CodexItem =
  | CodexReasoningItem
  | CodexAgentMessageItem
  | CodexWebSearchItem
  | CodexUnknownItem;

export type CodexStreamEvent = CodexJsonObject & {
  type: CodexEventType;
  item?: unknown;
  usage?: unknown;
};

export function parseCodexJsonObjectLine(line: string): CodexJsonObject | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as CodexJsonObject;
  } catch {
    return null;
  }
}

export function toCodexStreamEvent(value: CodexJsonObject | null): CodexStreamEvent | null {
  if (!value) {
    return null;
  }
  if (typeof value.type !== 'string') {
    return null;
  }
  return value as CodexStreamEvent;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out.length > 0 ? out : [];
}

function parseSearchAction(value: unknown): CodexSearchAction | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as CodexJsonObject;
  const type = asString(obj.type);
  if (!type) {
    return undefined;
  }
  return {
    type,
    query: asString(obj.query) ?? undefined,
    queries: asStringArray(obj.queries) ?? undefined
  };
}

export function parseCodexItem(value: unknown): CodexItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const obj = value as CodexJsonObject;
  const id = asString(obj.id);
  const type = asString(obj.type);
  if (!id || !type) {
    return null;
  }

  if (type === 'reasoning') {
    const text = asString(obj.text);
    if (!text) return null;
    return { id, type, text };
  }

  if (type === 'agent_message') {
    const text = asString(obj.text);
    if (!text) return null;
    return { id, type, text };
  }

  if (type === 'web_search') {
    const query = asString(obj.query);
    if (!query) return null;
    return {
      id,
      type,
      query,
      action: parseSearchAction(obj.action)
    };
  }

  return { id, type, raw: obj };
}
