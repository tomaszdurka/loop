import { spawn } from 'node:child_process';

type JudgeDecision = {
  passed: boolean;
  explanation: string;
  raw: string;
};

export type AgenticLoopConfig = {
  prompt: string;
  success?: string;
  maxIterations: number;
  provider: Provider;
  cwd: string;
};

type Provider = 'codex' | 'claude';

type ExecFailure = {
  kind: 'spawn_error' | 'command_not_found';
  message: string;
};

type WorkerResult =
  | { ok: true; code: number }
  | { ok: false; error: ExecFailure };

type JudgeRunResult =
  | { ok: true; code: number; stdout: string; stderr: string }
  | { ok: false; error: ExecFailure };

type GuardResult =
  | { ok: true }
  | { ok: false; reason: string };

function buildWorkerPrompt(basePrompt: string, feedback: string | null): string {
  if (!feedback) {
    return basePrompt;
  }

  return `${basePrompt}\n\nPrevious judge feedback: ${feedback}`;
}

function buildJudgePrompt(success: string): string {
  return [
    'You are a strict evaluator.',
    'Inspect the current workspace/files/artifacts to decide whether the task is complete.',
    `SUCCESS_CRITERIA: ${success}`,
    'Respond in exactly one line starting with either:',
    'YES: <short reason>',
    'or',
    'NO: <short reason>',
    'Do not include any extra lines.'
  ].join('\n');
}

function parseJudgeOutput(raw: string): JudgeDecision {
  const trimmed = raw.trim();

  if (/^YES\s*:/i.test(trimmed) || /^YES$/i.test(trimmed)) {
    return {
      passed: true,
      explanation: trimmed.replace(/^YES\s*:\s*/i, '') || 'Criteria met',
      raw
    };
  }

  if (/^NO\s*:/i.test(trimmed) || /^NO$/i.test(trimmed)) {
    return {
      passed: false,
      explanation: trimmed.replace(/^NO\s*:\s*/i, '') || 'Criteria not met',
      raw
    };
  }

  return {
    passed: false,
    explanation: 'Judge output malformed',
    raw
  };
}

function parseGuardOutput(raw: string): GuardResult {
  const trimmed = raw.trim();

  if (/^CONSISTENT\s*:/i.test(trimmed) || /^CONSISTENT$/i.test(trimmed)) {
    return { ok: true };
  }

  if (/^CONTRADICTION\s*:/i.test(trimmed) || /^CONTRADICTION$/i.test(trimmed)) {
    return {
      ok: false,
      reason: trimmed.replace(/^CONTRADICTION\s*:\s*/i, '') || 'Prompt and success criteria are contradictory'
    };
  }

  return {
    ok: false,
    reason: 'Guard output malformed'
  };
}

function toExecFailure(error: unknown, provider: Provider): ExecFailure {
  const errno = error as NodeJS.ErrnoException;
  if (errno?.code === 'ENOENT') {
    return { kind: 'command_not_found', message: `\`${provider}\` command not found in PATH.` };
  }
  return { kind: 'spawn_error', message: errno?.message ?? 'Failed to start process' };
}

function terminateWithError(error: ExecFailure): never {
  console.error(error.message);
  process.exit(error.kind === 'command_not_found' ? 127 : 1);
}

function buildProviderCommand(provider: Provider, prompt: string): { command: string; args: string[]; stdin: string | null } {
  if (provider === 'claude') {
    return {
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--print'],
      stdin: prompt
    };
  }

  return {
    command: 'codex',
    args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt],
    stdin: null
  };
}

function runWorker(provider: Provider, prompt: string, cwd: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const cmd = buildProviderCommand(provider, prompt);
    const child = spawn(cmd.command, cmd.args, {
      stdio: ['pipe', 'inherit', 'inherit'],
      cwd
    });

    child.on('error', (error) => resolve({ ok: false, error: toExecFailure(error, provider) }));
    child.on('close', (code) => resolve({ ok: true, code: code ?? 1 }));
    child.stdin?.end(cmd.stdin ? `${cmd.stdin}\n` : undefined);
  });
}

function runJudge(provider: Provider, judgePrompt: string, cwd: string): Promise<JudgeRunResult> {
  return new Promise((resolve) => {
    const cmd = buildProviderCommand(provider, judgePrompt);
    const child = spawn(cmd.command, cmd.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => resolve({ ok: false, error: toExecFailure(error, provider) }));
    child.on('close', (code) => {
      resolve({ ok: true, code: code ?? 1, stdout, stderr });
    });
    child.stdin?.end(cmd.stdin ? `${cmd.stdin}\n` : undefined);
  });
}

function buildContradictionGuardPrompt(prompt: string, success: string): string {
  return [
    'You are a strict consistency checker.',
    `TASK_PROMPT: ${prompt}`,
    `SUCCESS_CRITERIA: ${success}`,
    'Decide whether TASK_PROMPT and SUCCESS_CRITERIA are mutually contradictory.',
    'Respond in exactly one line as one of:',
    'CONSISTENT: <short reason>',
    'CONTRADICTION: <short reason>',
    'No extra text.'
  ].join('\n');
}

async function runContradictionGuard(provider: Provider, prompt: string, success: string, cwd: string): Promise<void> {
  const guardPrompt = buildContradictionGuardPrompt(prompt, success);
  const guardRun = await runJudge(provider, guardPrompt, cwd);

  if (!guardRun.ok) {
    terminateWithError(guardRun.error);
  }

  const guard = parseGuardOutput(guardRun.stdout);
  if (!guard.ok) {
    console.error(`Specification blocked: ${guard.reason}`);
    process.exit(3);
  }
}

export async function runAgenticLoopCommand(config: AgenticLoopConfig): Promise<void> {
  let feedback: string | null = null;


  if (!config.success) {
    const workerPrompt = buildWorkerPrompt(config.prompt, null);
    const workerRun = await runWorker(config.provider, workerPrompt, config.cwd);
    if (!workerRun.ok) {
      terminateWithError(workerRun.error);
    }
    const workerCode = workerRun.code;
    process.exit(workerCode);
  }


  await runContradictionGuard(config.provider, config.prompt, config.success, config.cwd);

  for (let i = 1; i <= config.maxIterations; i += 1) {
    console.log(`[Iteration ${i}/${config.maxIterations}] Judge start`);
    const judgePrompt = buildJudgePrompt(config.success);

    const judgeResult = await runJudge(config.provider, judgePrompt, config.cwd);
    if (!judgeResult.ok) {
      terminateWithError(judgeResult.error);
    }

    if (judgeResult.stderr.trim().length > 0) {
      console.error(judgeResult.stderr.trim());
    }

    const decision = parseJudgeOutput(judgeResult.stdout);

    console.log(`[Iteration ${i}/${config.maxIterations}] Judge raw: ${decision.raw.trim() || '<empty>'}`);
    console.log(`[Iteration ${i}/${config.maxIterations}] Judge decision: ${decision.passed ? 'YES' : 'NO'} - ${decision.explanation}`);

    if (decision.passed) {
      console.log('\nSuccess criteria met. Stopping loop.');
      process.exit(0);
    }

    feedback = decision.explanation;
    console.log(`[Iteration ${i}/${config.maxIterations}] Criteria not met. Running worker.`);

    const workerPrompt = buildWorkerPrompt(config.prompt, feedback);
    console.log(`[Iteration ${i}/${config.maxIterations}] Worker start`);

    const workerRun = await runWorker(config.provider, workerPrompt, config.cwd);
    if (!workerRun.ok) {
      terminateWithError(workerRun.error);
    }
    const workerCode = workerRun.code;

    console.log(`[Iteration ${i}/${config.maxIterations}] Worker done (exit ${workerCode})`);
  }

  console.log(`\n[Final Check] Judge start`);
  const finalJudge = await runJudge(config.provider, buildJudgePrompt(config.success), config.cwd);
  if (!finalJudge.ok) {
    terminateWithError(finalJudge.error);
  }
  if (finalJudge.stderr.trim().length > 0) {
    console.error(finalJudge.stderr.trim());
  }
  const finalDecision = parseJudgeOutput(finalJudge.stdout);
  console.log(`[Final Check] Judge raw: ${finalDecision.raw.trim() || '<empty>'}`);
  console.log(`[Final Check] Judge decision: ${finalDecision.passed ? 'YES' : 'NO'} - ${finalDecision.explanation}`);
  if (finalDecision.passed) {
    console.log('\nSuccess criteria met. Stopping loop.');
    process.exit(0);
  }

  console.error(`\nMax iterations reached (${config.maxIterations}) without success.`);
  process.exit(1);
}
