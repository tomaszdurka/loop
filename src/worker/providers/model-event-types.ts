export type ModelEventLevel = 'info' | 'warn' | 'error';

export type ModelEventKind =
  | 'assistant_message'
  | 'assistant_tool_result'
  | 'result_success'
  | 'result'
  | 'system'
  | 'user'
  | 'unknown';

export type ModelOutputContentItem =
  | { type: 'text'; content: string; format?: 'markdown' | 'text' }
  | { type: 'tool_use'; content: { tool_call_id: string | null; tool_name: string | null; input: unknown } }
  | { type: 'tool_result'; content: { tool_call_id: string | null; content: string } }
  | { type: 'unknown'; content: unknown };

export type ModelOutputType = 'message' | 'tool_use' | 'result' | 'unknown';

export type ModelOutputEventPayload = {
  level: ModelEventLevel;
  model_event_kind: ModelEventKind;
  type: ModelOutputType;
  message: ModelOutputContentItem[] | null;
  summary: string | null;
  result_message: string | null;
};
