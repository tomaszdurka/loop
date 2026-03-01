import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskRow } from '../queue/types.js';
import { RunStreamer, type StreamEnvelope } from './execute-runner.js';

export type WorkerRuntimeOptions = {
  streamJobLogs: boolean;
  provider: 'codex' | 'claude';
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
};

type LeaseResponse = {
  task: TaskRow | null;
  attempt_no?: number;
  attempt_id?: number;
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS_ROOT = resolve(PROJECT_ROOT, 'runs');
const SYSTEM_PROMPTS_DIR = resolve(PROJECT_ROOT, 'prompts', 'system');

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  stdin: string | null,
  timeoutMs: number,
  onOutputLine?: (line: string) => void
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    const emitLines = (chunkText: string): void => {
      if (!onOutputLine) {
        return;
      }
      lineBuffer += chunkText;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        onOutputLine(line);
      }
    };

    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      emitLines(text);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      emitLines(text);
    });

    child.on('error', (error) => {
      const message = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `Command not found: ${command}`
        : error.message;
      finish({ exitCode: null, stdout, stderr, spawnError: message });
    });

    child.on('close', (code) => {
      if (onOutputLine && lineBuffer.length > 0) {
        onOutputLine(lineBuffer);
      }
      finish({ exitCode: code, stdout, stderr, spawnError: null });
    });

    timeoutHandle = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      finish({
        exitCode: null,
        stdout,
        stderr,
        spawnError: `Command timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdin?.end(stdin ? `${stdin}\n` : undefined);
  });
}

async function postJson<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const msg = (parsed as { error?: string; message?: string }).error
      ?? (parsed as { error?: string; message?: string }).message
      ?? `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return parsed as T;
}

export async function leaseNextJob(baseUrl: string, workerId: string, leaseTtlMs: number): Promise<{ task: TaskRow | null; attemptNo: number | null; attemptId: number | null }> {
  const leased = await postJson<LeaseResponse>(baseUrl, '/tasks/lease', {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
  return {
    task: leased.task,
    attemptNo: leased.attempt_no ?? null,
    attemptId: leased.attempt_id ?? null
  };
}

async function heartbeat(baseUrl: string, workerId: string, taskId: string, leaseTtlMs: number): Promise<void> {
  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/heartbeat`, {
    worker_id: workerId,
    lease_ttl_ms: leaseTtlMs
  });
}

async function pushEnvelope(
  baseUrl: string,
  taskId: string,
  workerId: string,
  attemptId: number | null,
  envelope: StreamEnvelope
): Promise<void> {
  const level = envelope.type === 'error'
    ? 'error'
    : envelope.type === 'event' && envelope.payload.level === 'warn'
      ? 'warn'
      : 'info';

  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/events`, {
    worker_id: workerId,
    attempt_id: attemptId,
    phase: envelope.phase,
    level,
    message: envelope.type,
    data: { envelope }
  });
}

type RunSequenceRef = {
  value: number;
};

async function pushRunEvent(
  baseUrl: string,
  taskId: string,
  workerId: string,
  attemptId: number | null,
  runId: string,
  sequenceRef: RunSequenceRef,
  input: {
    phase: string;
    level: 'info' | 'warn' | 'error';
    eventName: string;
    message: string;
    data?: Record<string, unknown>;
  }
): Promise<void> {
  sequenceRef.value += 1;
  const envelope: StreamEnvelope = {
    run_id: runId,
    sequence: sequenceRef.value,
    timestamp: new Date().toISOString(),
    type: 'event',
    phase: input.phase,
    producer: 'system',
    payload: {
      event_name: input.eventName,
      level: input.level,
      message: input.message,
      data: input.data ?? {}
    }
  };
  await pushEnvelope(baseUrl, taskId, workerId, attemptId, envelope);
}

async function complete(baseUrl: string, workerId: string, taskId: string, payload: {
  worker_exit_code: number | null;
  output_json: Record<string, unknown>;
  final_phase: string;
  succeeded: boolean;
  blocked: boolean;
  error_message: string | null;
  finished_at: string;
}): Promise<void> {
  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/complete`, {
    worker_id: workerId,
    ...payload
  });
}

function createRunDir(runId: string): string {
  const runDir = resolve(RUNS_ROOT, runId);
  mkdirSync(runDir, { recursive: true });
  const sourceAgentsDir = resolve(PROJECT_ROOT, '.agents');
  const targetAgentsDir = resolve(runDir, '.agents');
  if (existsSync(sourceAgentsDir)) {
    cpSync(sourceAgentsDir, targetAgentsDir, { recursive: true });
  }
  return runDir;
}

function readSystemPromptFile(name: string): string {
  const filePath = resolve(SYSTEM_PROMPTS_DIR, name);
  if (!existsSync(filePath)) {
    throw new Error(`Missing prompt file: ${filePath}`);
  }
  return readFileSync(filePath, 'utf8').trim();
}

function readPhaseSchema(phaseName: string): { schemaJson: string; schemaPath: string } | null {
  const phaseSchemaFile: Record<string, string> = {
    mode: 'mode.schema.json',
    interpret: 'interpret.schema.json',
    plan: 'plan.schema.json',
    policy: 'policy.schema.json',
    verify: 'verify.schema.json',
    report: 'report.schema.json'
  };
  const fileName = phaseSchemaFile[phaseName];
  if (!fileName) {
    return null;
  }

  const schemaPath = resolve(SYSTEM_PROMPTS_DIR, 'schemas', fileName);
  if (!existsSync(schemaPath)) {
    throw new Error(`Missing schema file: ${schemaPath}`);
  }
  const raw = readFileSync(schemaPath, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return {
    schemaJson: JSON.stringify(parsed),
    schemaPath
  };
}

function buildProviderCommand(
  provider: 'codex' | 'claude',
  prompt: string,
  schema: { schemaJson: string; schemaPath: string } | null
): { command: string; args: string[]; stdin: string | null } {
  if (provider === 'claude') {
    const args = ['--dangerously-skip-permissions', '--print'];
    if (schema) {
      args.push( '--output-format', 'json', '--json-schema', schema.schemaJson);
    } else {
      args.push('--verbose', '--output-format', 'stream-json');
    }
    return {
      command: 'claude',
      args,
      stdin: prompt
    };
  }

  const args = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'];
  if (schema) {
    args.push('--output-schema', schema.schemaPath);
  }
  args.push(prompt);
  return {
    command: 'codex',
    args,
    stdin: null
  };
}

function buildPhasePrompt(base: string, phaseText: string, input: Record<string, unknown>): string {
  return [
    base,
    '',
    phaseText,
    '',
    'INPUT_JSON:',
    JSON.stringify(input, null, 2)
  ].join('\n');
}

function extractJsonFromText(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  const direct = fenced?.[1] ?? raw;
  const firstBrace = direct.indexOf('{');
  const lastBrace = direct.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error('No JSON object found in model output');
  }
  const candidate = direct.slice(firstBrace, lastBrace + 1);
  const parsed = JSON.parse(candidate) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Model output JSON is not an object');
  }
  return parsed as Record<string, unknown>;
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('No JSON object found in model output');
  }

  // First try plain direct extraction (legacy behavior).
  try {
    return extractJsonFromText(trimmed);
  } catch {
    // continue with structured wrapper parsing
  }

  let parsedTop: unknown;
  try {
    parsedTop = JSON.parse(trimmed);
  } catch {
    throw new Error('No JSON object found in model output');
  }

  const unwrap = (value: unknown): Record<string, unknown> | null => {
    if (!value) {
      return null;
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const candidateKeys = ['result', 'output', 'text', 'message', 'content'];
      for (const key of candidateKeys) {
        const candidate = obj[key];
        if (typeof candidate === 'string') {
          try {
            return extractJsonFromText(candidate);
          } catch {
            // keep scanning wrappers
          }
        }
        if (Array.isArray(candidate)) {
          const textJoined = candidate
            .map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
              ? (entry as Record<string, unknown>).text
              : ''))
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
            .join('\n');
          if (textJoined) {
            try {
              return extractJsonFromText(textJoined);
            } catch {
              // keep scanning wrappers
            }
          }
        }
      }
      return obj;
    }
    return null;
  };

  const unwrapped = unwrap(parsedTop);
  if (unwrapped) {
    return unwrapped;
  }

  throw new Error('No JSON object found in model output');
}

function parseStreamJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

type ClaudeStreamNormalized = {
  type: string | null;
  subtype: string | null;
  messageBody: string | null;
  terminalResultText: string | null;
};

function extractClaudeTerminalResultText(streamItem: Record<string, unknown>): string | null {
  const itemType = typeof streamItem.type === 'string' ? streamItem.type : null;
  if (itemType !== 'result') {
    return null;
  }
  const result = streamItem.result;
  if (typeof result === 'string') {
    return result;
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return JSON.stringify(result);
  }
  return null;
}

function extractClaudeMessageBody(parsedLine: Record<string, unknown>): string | null {
  const itemType = typeof parsedLine.type === 'string' ? parsedLine.type : null;

  if (itemType === 'assistant') {
    const message = parsedLine.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
      const content = (message as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const textParts = content
          .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              return null;
            }
            const part = entry as Record<string, unknown>;
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
              return part.text;
            }
            return null;
          })
          .filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (textParts.length > 0) {
          return textParts.join('\n');
        }
      }
    }
  }

  if (itemType === 'result' && typeof parsedLine.result === 'string' && parsedLine.result.trim().length > 0) {
    return parsedLine.result;
  }

  return null;
}

function normalizeClaudeStreamLine(rawLine: string, parsedLine: Record<string, unknown> | null): ClaudeStreamNormalized {
  if (!parsedLine) {
    return {
      type: null,
      subtype: null,
      messageBody: null,
      terminalResultText: null
    };
  }

  const type = typeof parsedLine.type === 'string' ? parsedLine.type : null;
  const subtype = typeof parsedLine.subtype === 'string' ? parsedLine.subtype : null;
  return {
    type,
    subtype,
    messageBody: extractClaudeMessageBody(parsedLine),
    terminalResultText: extractClaudeTerminalResultText(parsedLine)
  };
}

function buildModelOutputEventPayloadForClaude(
  normalized: ClaudeStreamNormalized
): Record<string, unknown> {
  return {
    level: 'info',
    message_body: normalized.messageBody,
    model_event_type: normalized.type,
    model_event_subtype: normalized.subtype
  };
}

function extractModelMessageBody(parsedLine: Record<string, unknown>): string | null {
  const message = parsedLine.message;
  if (message && typeof message === 'object' && !Array.isArray(message)) {
    const messageObj = message as Record<string, unknown>;
    const content = messageObj.content;
    if (Array.isArray(content)) {
      const textParts = content
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return null;
          }
          const obj = entry as Record<string, unknown>;
          if (typeof obj.text === 'string' && obj.text.trim().length > 0) {
            return obj.text;
          }
          if (obj.type === 'tool_use') {
            const name = typeof obj.name === 'string' ? obj.name : 'tool';
            return `[tool_use:${name}]`;
          }
          return null;
        })
        .filter((v): v is string => typeof v === 'string' && v.length > 0);
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }
  }

  if (typeof parsedLine.result === 'string' && parsedLine.result.trim().length > 0) {
    return parsedLine.result;
  }

  if (typeof parsedLine.message === 'string' && parsedLine.message.trim().length > 0) {
    return parsedLine.message;
  }

  return null;
}

function buildModelOutputEventPayload(
  rawLine: string,
  parsedLine: Record<string, unknown> | null
): Record<string, unknown> {
  if (!parsedLine) {
    return {
      level: 'info',
      message: rawLine,
      raw_message: rawLine,
      model_event_type: null,
      model_event_subtype: null,
      message_body: rawLine
    };
  }

  return {
    level: 'info',
    message: parsedLine,
    model_event_type: typeof parsedLine.type === 'string' ? parsedLine.type : null,
    model_event_subtype: typeof parsedLine.subtype === 'string' ? parsedLine.subtype : null,
    message_body: extractModelMessageBody(parsedLine)
  };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((x) => typeof x === 'string') as string[];
}

function evaluateVerifyPass(verify: Record<string, unknown>): boolean {
  if (verify.pass === true) {
    return true;
  }
  if (verify.passed === true) {
    return true;
  }
  if (verify.success === true) {
    return true;
  }
  if (verify.verified === true) {
    return true;
  }
  if (verify.success_criteria_met === true) {
    return true;
  }
  if (verify.verification_status === 'success') {
    return true;
  }
  if (verify.verification_status === 'passed') {
    return true;
  }
  if (verify.status === 'success' || verify.status === 'passed') {
    return true;
  }
  return false;
}

function getByPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.').map((p) => p.trim()).filter((p) => p.length > 0);
  let current: unknown = root;
  for (const part of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function computeIdempotencyKey(task: TaskRow, interpret: Record<string, unknown>, policy: Record<string, unknown>): string {
  const idempotency = (policy.idempotency && typeof policy.idempotency === 'object')
    ? policy.idempotency as Record<string, unknown>
    : {};

  const keyFields = asStringArray(idempotency.key_fields);
  const objective = typeof interpret.objective === 'string' ? interpret.objective : '';

  const source: Record<string, unknown> = {
    task: {
      id: task.id,
      type: task.type,
      title: task.title,
      prompt: task.prompt
    },
    interpret: {
      objective
    }
  };

  const canonicalFromFields = keyFields.map((k) => `${k}=${JSON.stringify(getByPath(source, k) ?? null)}`).join('|');
  const resolvedAny = keyFields.some((k) => getByPath(source, k) !== undefined);

  const canonical = keyFields.length > 0 && resolvedAny
    ? canonicalFromFields
    : `${task.id}|${task.type}|${task.title}|${task.prompt}|${objective}`;

  return createHash('sha256').update(canonical).digest('hex');
}

function resolveExecuteSchemaOverride(
  runDir: string,
  plan: Record<string, unknown>
): { schemaJson: string; schemaPath: string } | null {
  const strict = plan.execute_output_strict === true;
  const formatRaw = plan.execute_output_format;
  const format = typeof formatRaw === 'string' ? formatRaw.toLowerCase() : '';
  if (!strict || format !== 'json') {
    return null;
  }

  let schemaCandidate = plan.execute_output_schema;
  if (typeof schemaCandidate === 'string') {
    try {
      schemaCandidate = JSON.parse(schemaCandidate);
    } catch {
      return null;
    }
  }

  if (!schemaCandidate || typeof schemaCandidate !== 'object' || Array.isArray(schemaCandidate)) {
    return null;
  }

  const schemaPath = resolve(runDir, 'execute.output.schema.json');
  const schemaJson = JSON.stringify(schemaCandidate);
  writeFileSync(schemaPath, JSON.stringify(schemaCandidate, null, 2), 'utf8');
  return { schemaJson, schemaPath };
}

async function runPhase(
  provider: 'codex' | 'claude',
  runDir: string,
  streamJobLogs: boolean,
  runLabel: string,
  phaseName: string,
  phasePrompt: string,
  phaseTimeoutMs: number,
  schemaOverride: { schemaJson: string; schemaPath: string } | null = null,
  onOutput?: (output: string, parsedLine: Record<string, unknown> | null) => void
): Promise<Record<string, unknown>> {
  if (streamJobLogs) {
    console.log(`[run/${runLabel}][${phaseName}] start`);
  }

  const schema = schemaOverride ?? readPhaseSchema(phaseName);
  const cmd = buildProviderCommand(provider, phasePrompt, schema);
  const isExecuteStreamJson = provider === 'claude' && phaseName === 'execute' && !schema;
  let terminalResultText: string | null = null;
  const result = await runCommand(
    cmd.command,
    cmd.args,
    runDir,
    cmd.stdin,
    phaseTimeoutMs,
    (line) => {
      const item = parseStreamJsonLine(line);
      if (isExecuteStreamJson) {
        const normalized = normalizeClaudeStreamLine(line, item);
        if (normalized.messageBody) {
          onOutput?.(line, item);
        }
        if (typeof normalized.terminalResultText === 'string' && normalized.terminalResultText.length > 0) {
          terminalResultText = normalized.terminalResultText;
        }
        return;
      }

      onOutput?.(line, item);
    }
  );
  if (result.spawnError) {
    if (streamJobLogs) {
      console.log(`[run/${runLabel}][${phaseName}] spawn_error=${result.spawnError}`);
    }
    throw new Error(result.spawnError);
  }
  if (result.exitCode !== 0) {
    if (streamJobLogs) {
      console.log(`[run/${runLabel}][${phaseName}] exit_code=${result.exitCode}`);
    }
    throw new Error(`${phaseName} failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`);
  }

  let parsed: Record<string, unknown>;
  if (isExecuteStreamJson) {
    if (!terminalResultText) {
      throw new Error('No terminal stream result (type="result") found in execute output');
    }
    try {
      parsed = extractJsonObject(terminalResultText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse terminal execute stream result: ${message}`);
    }
  } else {
    parsed = extractJsonObject(result.stdout || result.stderr);
  }
  if (streamJobLogs) {
    console.log(`[run/${runLabel}][${phaseName}] done`);
  }
  return parsed;
}

async function readState(baseUrl: string, key: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${baseUrl}/state/${encodeURIComponent(key)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to read state key ${key}: HTTP ${response.status}`);
  }
  const parsed = await response.json() as { key: string; value: Record<string, unknown> };
  return parsed.value;
}

async function writeState(baseUrl: string, key: string, value: Record<string, unknown>): Promise<void> {
  await postJson(baseUrl, `/state/${encodeURIComponent(key)}`, { value });
}

function getTaskMode(task: TaskRow): 'auto' | 'lean' | 'full' {
  const maybeApiTask = task as unknown as { task_request?: unknown; task_request_json?: unknown };

  try {
    // Lease API returns task_request object; DB row uses task_request_json.
    if (maybeApiTask.task_request && typeof maybeApiTask.task_request === 'object') {
      const mode = (maybeApiTask.task_request as { mode?: unknown }).mode;
      if (mode === 'lean' || mode === 'full' || mode === 'auto') {
        return mode;
      }
    }

    if (typeof maybeApiTask.task_request_json === 'string') {
      const request = JSON.parse(maybeApiTask.task_request_json) as { mode?: unknown };
      if (request.mode === 'lean' || request.mode === 'full' || request.mode === 'auto') {
        return request.mode;
      }
    }
  } catch {
    // Ignore malformed task_request_json and fallback to auto.
  }
  return 'auto';
}

export async function runLeasedJob(
  baseUrl: string,
  workerId: string,
  leaseTtlMs: number,
  phaseTimeoutMs: number,
  task: TaskRow,
  attemptId: number | null,
  options: WorkerRuntimeOptions
): Promise<boolean> {
  const runId = `run_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 6)}`;
  const runLabel = runId.slice(4);
  const runDir = createRunDir(runId);
  const sequenceRef: RunSequenceRef = { value: 0 };
  const executeStreamer = new RunStreamer(runId, 'execute', async (envelope) => {
    await pushEnvelope(baseUrl, task.id, workerId, attemptId, envelope);
  }, sequenceRef);

  const heartbeatTimer = setInterval(() => {
    heartbeat(baseUrl, workerId, task.id, leaseTtlMs).catch((error) => {
      console.error(`[queue-worker] heartbeat failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, Math.max(1000, Math.floor(leaseTtlMs / 3)));

  try {
    const basePrompt = readSystemPromptFile('00_executor_base.md');
    const modeClassifierPrompt = readSystemPromptFile('05_mode_classifier.md');
    const interpretPrompt = readSystemPromptFile('10_interpret.md');
    const planPrompt = readSystemPromptFile('20_plan.md');
    const policyPrompt = readSystemPromptFile('30_execution_policy.md');
    const verifyPrompt = readSystemPromptFile('40_verify.md');
    const reportPrompt = readSystemPromptFile('50_report.md');

    const configuredMode = getTaskMode(task);
    let effectiveMode: 'lean' | 'full' = 'lean';
    let modeDecision: Record<string, unknown> | null = null;

    if (configuredMode === 'lean' || configuredMode === 'full') {
      effectiveMode = configuredMode;
    } else {
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'mode',
        level: 'info',
        eventName: 'mode_classification_started',
        message: 'Mode classification started'
      });
      modeDecision = await runPhase(
        options.provider,
        runDir,
        options.streamJobLogs,
        runLabel,
        'mode',
        buildPhasePrompt(basePrompt, modeClassifierPrompt, {
          task: {
            id: task.id,
            type: task.type,
            title: task.title,
            prompt: task.prompt,
            success_criteria: task.success_criteria
          }
        }),
        phaseTimeoutMs
      );
      effectiveMode = modeDecision.mode === 'full' ? 'full' : 'lean';
    }

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'mode',
      level: 'info',
      eventName: 'mode_selected',
      message: 'Mode selected',
      data: {
        configured_mode: configuredMode,
        effective_mode: effectiveMode,
        classifier: modeDecision
      }
    });

    if (effectiveMode === 'lean') {
      await executeStreamer.emitStateChange({ from: 'pending', to: 'running' });
      await executeStreamer.emitEvent({
        level: 'info',
        message: 'Execute loop started',
        data: { mode: 'lean' }
      });

      const executePrompt = buildPhasePrompt(
        basePrompt,
        [
          '# Execute Phase',
          '',
          'Role:',
          '- Execute this task directly with minimal overhead.',
          '',
          'Return JSON only with shape:',
          '{',
          '  "status": "succeeded|failed",',
          '  "summary": "string",',
          '  "evidence": ["string"],',
          '  "artifacts": ["string"],',
          '  "errors": ["string"]',
          '}'
        ].join('\n'),
        { task, mode: effectiveMode }
      );
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'execute',
        level: 'info',
        eventName: 'execution_started',
        message: 'Execution started',
        data: { llm_prompt: executePrompt }
      });
      const executeActionId = `a_${randomUUID().slice(0, 8)}`;
      const executeIdempotencyKey = `ik:${task.id}:execute:${executeActionId}`;
      await executeStreamer.emitAction({
        action_id: executeActionId,
        step_id: 'S_EXEC',
        tool: 'llm_execute',
        arguments: { prompt: executePrompt },
        idempotency_key: executeIdempotencyKey
      });

      const execute = await runPhase(
        options.provider,
        runDir,
        options.streamJobLogs,
        runLabel,
        'execute',
        executePrompt,
        phaseTimeoutMs,
        null,
        (output, parsedLine) => {
          if (!output.trim()) {
            return;
          }
          if (options.provider === 'claude') {
            const normalized = normalizeClaudeStreamLine(output, parsedLine);
            if (!normalized.messageBody) {
              return;
            }
            void executeStreamer.emitModelOutput(buildModelOutputEventPayloadForClaude(normalized));
            return;
          }
          void executeStreamer.emitModelOutput(buildModelOutputEventPayload(output, parsedLine));
        }
      );
      await executeStreamer.emitToolResult({
        action_id: executeActionId,
        step_id: 'S_EXEC',
        tool: 'llm_execute',
        ok: execute.status === 'succeeded',
        result: execute,
        truncated: false
      });
      await executeStreamer.emitArtifact({
        name: 'result',
        format: 'json',
        content: execute
      }, 'system');
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'execute',
        level: 'info',
        eventName: 'execution_completed',
        message: 'Execution completed',
        data: { output: execute }
      });

      let verify: Record<string, unknown>;
      if (task.success_criteria && task.success_criteria.trim().length > 0) {
        await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
          phase: 'verify',
          level: 'info',
          eventName: 'verification_started',
          message: 'Verification started'
        });
        verify = await runPhase(
          options.provider,
          runDir,
          options.streamJobLogs,
          runLabel,
          'verify',
          buildPhasePrompt(basePrompt, verifyPrompt, {
            task,
            execute_result: execute
          }),
          phaseTimeoutMs
        );
        await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
          phase: 'verify',
          level: 'info',
          eventName: 'verification_completed',
          message: 'Verification completed',
          data: { output: verify }
        });
      } else {
        const pass = execute.status === 'succeeded';
        verify = {
          pass,
          evidence: ['Lean mode: no explicit success_criteria provided; used execute status'],
          failures: pass ? [] : ['Execution did not return succeeded'],
          recommended_next_actions: pass ? [] : ['Add success_criteria for stronger verification']
        };
        await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
          phase: 'verify',
          level: 'info',
          eventName: 'verification_skipped',
          message: 'Verification skipped (no success_criteria)',
          data: { fallback_pass: pass }
        });
      }

      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'report',
        level: 'info',
        eventName: 'reporting_started',
        message: 'Reporting started'
      });
      const report = await runPhase(
        options.provider,
        runDir,
        options.streamJobLogs,
        runLabel,
        'report',
        buildPhasePrompt(basePrompt, reportPrompt, {
          task,
          verify,
          execute_result: execute
        }),
        phaseTimeoutMs
      );
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'report',
        level: 'info',
        eventName: 'reporting_completed',
        message: 'Reporting completed',
        data: { output: report }
      });

      const pass = evaluateVerifyPass(verify);
      await complete(baseUrl, workerId, task.id, {
        worker_exit_code: 0,
        output_json: {
          mode: { configured: configuredMode, effective: effectiveMode, classifier: modeDecision },
          phase_outputs: { execute, verify, report },
          run_dir: runDir
        },
        final_phase: 'report',
        succeeded: pass,
        blocked: false,
        error_message: pass ? null : 'Verification failed',
        finished_at: new Date().toISOString()
      });
      await executeStreamer.emitStateChange({ from: 'running', to: pass ? 'succeeded' : 'failed' });
      return pass;
    }

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'interpret',
      level: 'info',
      eventName: 'interpretation_started',
      message: 'Interpretation started'
    });
    const interpret = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'interpret',
      buildPhasePrompt(basePrompt, interpretPrompt, {
        task: {
          id: task.id,
          prompt: task.prompt,
          success_criteria: task.success_criteria,
          type: task.type,
          title: task.title
        }
      }),
      phaseTimeoutMs
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'interpret',
      level: 'info',
      eventName: 'interpretation_completed',
      message: 'Interpretation completed',
      data: { output: interpret }
    });

    const criticalBlocker = interpret.critical_blocker === true;
    const requestedBlockedRoute = interpret.route === 'blocked_for_clarification';
    if (requestedBlockedRoute && criticalBlocker) {
      const outputJson = {
        phase_outputs: { interpret },
        report: {
          message_markdown: `- Outcome: blocked for clarification\n- Missing info: ${asStringArray(interpret.clarifications_needed).join('; ') || 'unspecified'}`
        }
      };

      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'interpret',
        level: 'warn',
        eventName: 'blocked_for_clarification',
        message: 'Task blocked for clarification',
        data: {
          clarifications_needed: interpret.clarifications_needed ?? []
        }
      });

      await complete(baseUrl, workerId, task.id, {
        worker_exit_code: 0,
        output_json: outputJson,
        final_phase: 'interpret',
        succeeded: false,
        blocked: true,
        error_message: 'Blocked for clarification',
        finished_at: new Date().toISOString()
      });
      return false;
    }

    if (requestedBlockedRoute && !criticalBlocker) {
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'interpret',
        level: 'warn',
        eventName: 'clarification_ignored',
        message: 'Non-critical clarification ignored; continuing',
        data: {
          clarifications_needed: interpret.clarifications_needed ?? []
        }
      });
    }

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'plan',
      level: 'info',
      eventName: 'planning_started',
      message: 'Planning started'
    });
    const plan = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'plan',
      buildPhasePrompt(basePrompt, planPrompt, { task, interpret }),
      phaseTimeoutMs
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'plan',
      level: 'info',
      eventName: 'planning_completed',
      message: 'Planning completed',
      data: { output: plan }
    });

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'policy',
      level: 'info',
      eventName: 'policy_started',
      message: 'Execution policy started'
    });
    const executionPolicy = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'policy',
      buildPhasePrompt(basePrompt, policyPrompt, { task, interpret, plan }),
      phaseTimeoutMs
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'policy',
      level: 'info',
      eventName: 'policy_completed',
      message: 'Execution policy completed',
      data: { output: executionPolicy }
    });
    const executeSchemaOverride = resolveExecuteSchemaOverride(runDir, plan);
    if (executeSchemaOverride) {
      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'policy',
        level: 'info',
        eventName: 'execute_schema_enforced',
        message: 'Execute schema enforced from plan',
        data: {
          execute_output_format: plan.execute_output_format ?? 'json',
          execute_output_strict: true
        }
      });
    }

    const idempotencyKey = computeIdempotencyKey(task, interpret, executionPolicy);
    const stateKey = `idempotency:${idempotencyKey}`;
    const existingDone = await readState(baseUrl, stateKey);

    if (existingDone) {
      const outputJson = {
        phase_outputs: { interpret, plan, executionPolicy },
        dedupe: {
          idempotency_key: idempotencyKey,
          reused: true,
          existing: existingDone
        },
        report: {
          message_markdown: '- Outcome: deduplicated\n- Action: reused existing completion record'
        }
      };

      await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
        phase: 'policy',
        level: 'info',
        eventName: 'dedup_hit',
        message: 'Deduplication hit',
        data: { idempotency_key: idempotencyKey }
      });

      await complete(baseUrl, workerId, task.id, {
        worker_exit_code: 0,
        output_json: outputJson,
        final_phase: 'policy',
        succeeded: true,
        blocked: false,
        error_message: null,
        finished_at: new Date().toISOString()
      });
      return true;
    }

    const executePrompt = buildPhasePrompt(
      basePrompt,
      [
        '# Execute Phase',
        '',
        'Role:',
        '- Execute the planned work now and return structured results.',
        '',
        'Return JSON only with shape:',
        '{',
        '  "status": "succeeded|failed",',
        '  "summary": "string",',
        '  "evidence": ["string"],',
        '  "artifacts": ["string"],',
        '  "errors": ["string"]',
        '}'
      ].join('\n'),
      { task, interpret, plan, execution_policy: executionPolicy }
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'execute',
      level: 'info',
      eventName: 'execution_started',
      message: 'Execution started',
      data: { llm_prompt: executePrompt }
    });
    await executeStreamer.emitStateChange({ from: 'pending', to: 'running' });
    await executeStreamer.emitEvent({
      level: 'info',
      message: 'Execute loop started',
      data: { mode: 'full' }
    });
    const executeActionId = `a_${randomUUID().slice(0, 8)}`;
    const executeIdempotencyKey = `ik:${task.id}:execute:${executeActionId}`;
    await executeStreamer.emitAction({
      action_id: executeActionId,
      step_id: 'S_EXEC',
      tool: 'llm_execute',
      arguments: { prompt: executePrompt },
      idempotency_key: executeIdempotencyKey
    });

    const execute = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'execute',
      executePrompt,
      phaseTimeoutMs,
      executeSchemaOverride,
      (output, parsedLine) => {
        if (!output.trim()) {
          return;
        }
        if (options.provider === 'claude') {
          const normalized = normalizeClaudeStreamLine(output, parsedLine);
          if (!normalized.messageBody) {
            return;
          }
          void executeStreamer.emitModelOutput(buildModelOutputEventPayloadForClaude(normalized));
          return;
        }
        void executeStreamer.emitModelOutput(buildModelOutputEventPayload(output, parsedLine));
      }
    );
    await executeStreamer.emitToolResult({
      action_id: executeActionId,
      step_id: 'S_EXEC',
      tool: 'llm_execute',
      ok: execute.status === 'succeeded',
      result: execute,
      truncated: false
    });
    await executeStreamer.emitArtifact({
      name: 'result',
      format: 'json',
      content: execute
    }, 'system');
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'execute',
      level: 'info',
      eventName: 'execution_completed',
      message: 'Execution completed',
      data: { output: execute }
    });

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'verify',
      level: 'info',
      eventName: 'verification_started',
      message: 'Verification started'
    });
    const verify = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'verify',
      buildPhasePrompt(basePrompt, verifyPrompt, {
        task,
        interpret,
        plan,
        execution_policy: executionPolicy,
        execute_result: execute
      }),
      phaseTimeoutMs
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'verify',
      level: 'info',
      eventName: 'verification_completed',
      message: 'Verification completed',
      data: { output: verify }
    });

    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'report',
      level: 'info',
      eventName: 'reporting_started',
      message: 'Reporting started'
    });
    const report = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'report',
      buildPhasePrompt(basePrompt, reportPrompt, {
        task,
        verify,
        execute_result: execute
      }),
      phaseTimeoutMs
    );
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'report',
      level: 'info',
      eventName: 'reporting_completed',
      message: 'Reporting completed',
      data: { output: report }
    });

    const pass = evaluateVerifyPass(verify);
    const outputJson = {
      mode: { configured: configuredMode, effective: effectiveMode, classifier: modeDecision },
      idempotency_key: idempotencyKey,
      phase_outputs: {
        interpret,
        plan,
        execution_policy: executionPolicy,
        execute,
        verify,
        report
      },
      run_dir: runDir
    };

    if (pass) {
      await writeState(baseUrl, stateKey, {
        task_id: task.id,
        completed_at: new Date().toISOString(),
        verify
      });
    }

    await complete(baseUrl, workerId, task.id, {
      worker_exit_code: 0,
      output_json: outputJson,
      final_phase: 'report',
      succeeded: pass,
      blocked: false,
      error_message: pass ? null : 'Verification failed',
      finished_at: new Date().toISOString()
    });
    await executeStreamer.emitStateChange({ from: 'running', to: pass ? 'succeeded' : 'failed' });

    return pass;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pushRunEvent(baseUrl, task.id, workerId, attemptId, runId, sequenceRef, {
      phase: 'runtime',
      level: 'error',
      eventName: 'runtime_error',
      message: 'Worker runtime error',
      data: { message }
    });

    await complete(baseUrl, workerId, task.id, {
      worker_exit_code: 1,
      output_json: { error: message },
      final_phase: 'runtime',
      succeeded: false,
      blocked: false,
      error_message: message,
      finished_at: new Date().toISOString()
    });
    await executeStreamer.emitError({
      code: 'EXECUTE_RUNTIME_ERROR',
      message
    });
    await executeStreamer.emitStateChange({ from: 'running', to: 'failed' });
    return false;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
