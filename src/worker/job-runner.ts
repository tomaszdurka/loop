import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

async function pushEvent(
  baseUrl: string,
  taskId: string,
  workerId: string,
  attemptId: number | null,
  phase: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>
): Promise<void> {
  await postJson(baseUrl, `/tasks/${encodeURIComponent(taskId)}/events`, {
    worker_id: workerId,
    attempt_id: attemptId,
    phase,
    level,
    message,
    data: data ?? {}
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
    const args = ['--dangerously-skip-permissions', '--print', '--output-format', 'json'];
    if (schema) {
      args.push('--json-schema', schema.schemaJson);
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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((x) => typeof x === 'string') as string[];
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

async function runPhase(
  provider: 'codex' | 'claude',
  runDir: string,
  streamJobLogs: boolean,
  runLabel: string,
  phaseName: string,
  phasePrompt: string,
  phaseTimeoutMs: number
): Promise<Record<string, unknown>> {
  if (streamJobLogs) {
    console.log(`[run/${runLabel}][${phaseName}] start`);
  }
  const schema = readPhaseSchema(phaseName);
  const cmd = buildProviderCommand(provider, phasePrompt, schema);
  const result = await runCommand(cmd.command, cmd.args, runDir, cmd.stdin, phaseTimeoutMs);
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

  const parsed = extractJsonObject(result.stdout || result.stderr);
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
  const executeStreamer = new RunStreamer(runId, 'execute', async (envelope) => {
    await pushEnvelope(baseUrl, task.id, workerId, attemptId, envelope);
  });

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
      await pushEvent(baseUrl, task.id, workerId, attemptId, 'mode', 'info', 'Mode classification started');
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

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'mode', 'info', 'Mode selected', {
      configured_mode: configuredMode,
      effective_mode: effectiveMode,
      classifier: modeDecision
    });

    if (effectiveMode === 'lean') {
      await executeStreamer.emitStateChange({ from: 'pending', to: 'running' });
      await executeStreamer.emitEvent({
        level: 'info',
        message: 'Execute loop started',
        data: { mode: 'lean' }
      });

      await pushEvent(baseUrl, task.id, workerId, attemptId, 'execute', 'info', 'Execution started');
      const executeActionId = `a_${randomUUID().slice(0, 8)}`;
      const executeIdempotencyKey = `ik:${task.id}:execute:${executeActionId}`;
      await executeStreamer.emitAction({
        action_id: executeActionId,
        step_id: 'S_EXEC',
        tool: 'llm_execute',
        arguments: { prompt: task.prompt },
        idempotency_key: executeIdempotencyKey
      });

      const execute = await runPhase(
        options.provider,
        runDir,
        options.streamJobLogs,
        runLabel,
        'execute',
        buildPhasePrompt(
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
        ),
        phaseTimeoutMs
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

      let verify: Record<string, unknown>;
      if (task.success_criteria && task.success_criteria.trim().length > 0) {
        await pushEvent(baseUrl, task.id, workerId, attemptId, 'verify', 'info', 'Verification started');
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
      } else {
        const pass = execute.status === 'succeeded';
        verify = {
          pass,
          evidence: ['Lean mode: no explicit success_criteria provided; used execute status'],
          failures: pass ? [] : ['Execution did not return succeeded'],
          recommended_next_actions: pass ? [] : ['Add success_criteria for stronger verification']
        };
        await pushEvent(baseUrl, task.id, workerId, attemptId, 'verify', 'info', 'Verification skipped (no success_criteria)', {
          fallback_pass: pass
        });
      }

      await pushEvent(baseUrl, task.id, workerId, attemptId, 'report', 'info', 'Reporting started');
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

      const pass = verify.pass === true;
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

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'interpret', 'info', 'Interpretation started');
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

    const criticalBlocker = interpret.critical_blocker === true;
    const requestedBlockedRoute = interpret.route === 'blocked_for_clarification';
    if (requestedBlockedRoute && criticalBlocker) {
      const outputJson = {
        phase_outputs: { interpret },
        report: {
          message_markdown: `- Outcome: blocked for clarification\n- Missing info: ${asStringArray(interpret.clarifications_needed).join('; ') || 'unspecified'}`
        }
      };

      await pushEvent(baseUrl, task.id, workerId, attemptId, 'interpret', 'warn', 'Task blocked for clarification', {
        clarifications_needed: interpret.clarifications_needed ?? []
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
      await pushEvent(baseUrl, task.id, workerId, attemptId, 'interpret', 'warn', 'Non-critical clarification ignored; continuing', {
        clarifications_needed: interpret.clarifications_needed ?? []
      });
    }

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'plan', 'info', 'Planning started');
    const plan = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'plan',
      buildPhasePrompt(basePrompt, planPrompt, { task, interpret }),
      phaseTimeoutMs
    );

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'policy', 'info', 'Execution policy started');
    const executionPolicy = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'policy',
      buildPhasePrompt(basePrompt, policyPrompt, { task, interpret, plan }),
      phaseTimeoutMs
    );

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

      await pushEvent(baseUrl, task.id, workerId, attemptId, 'policy', 'info', 'Deduplication hit', {
        idempotency_key: idempotencyKey
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

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'execute', 'info', 'Execution started');
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
      arguments: { prompt: task.prompt },
      idempotency_key: executeIdempotencyKey
    });

    const execute = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'execute',
      buildPhasePrompt(
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
      ),
      phaseTimeoutMs
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

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'verify', 'info', 'Verification started');
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

    await pushEvent(baseUrl, task.id, workerId, attemptId, 'report', 'info', 'Reporting started');
    const report = await runPhase(
      options.provider,
      runDir,
      options.streamJobLogs,
      runLabel,
      'report',
      buildPhasePrompt(reportPrompt, '# Input\nReturn JSON only.', {
        task,
        verify,
        execute_result: execute
      }),
      phaseTimeoutMs
    );

    const pass = verify.pass === true;
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
    await pushEvent(baseUrl, task.id, workerId, attemptId, 'runtime', 'error', 'Worker runtime error', { message });

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
