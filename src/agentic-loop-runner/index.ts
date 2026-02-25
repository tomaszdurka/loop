#!/usr/bin/env node

import { spawn } from 'node:child_process';

type JudgeDecision = {
  passed: boolean;
  explanation: string;
  raw: string;
};

type Config = {
  prompt: string;
  success?: string;
  maxIterations: number;
};

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

function usage(): string {
  return [
    'Usage:',
    '  npm run loop -- --prompt "..." --success "..." [--max-iterations 5]'
  ].join('\n');
}

function parseArgs(argv: string[]): Config {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${token}`);
    }

    args.set(token, value);
    i += 1;
  }

  const prompt = args.get('--prompt');
  const success = args.get('--success');

  if (!prompt) {
    throw new Error('Both --prompt is required.');
  }

  const maxIterationsRaw = args.get('--max-iterations') ?? '5';
  const maxIterations = Number(maxIterationsRaw);

  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error('--max-iterations must be an integer >= 1');
  }

  return { prompt, success, maxIterations };
}

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

function toExecFailure(error: unknown): ExecFailure {
  const errno = error as NodeJS.ErrnoException;
  if (errno?.code === 'ENOENT') {
    return { kind: 'command_not_found', message: '`codex` command not found in PATH.' };
  }
  return { kind: 'spawn_error', message: errno?.message ?? 'Failed to start process' };
}

function terminateWithError(error: ExecFailure): never {
  console.error(error.message);
  process.exit(error.kind === 'command_not_found' ? 127 : 1);
}

function runWorker(prompt: string): Promise<WorkerResult> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt], {
      stdio: 'inherit'
    });

    child.on('error', (error) => resolve({ ok: false, error: toExecFailure(error) }));
    child.on('close', (code) => resolve({ ok: true, code: code ?? 1 }));
  });
}

function runJudge(judgePrompt: string): Promise<JudgeRunResult> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', judgePrompt], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => resolve({ ok: false, error: toExecFailure(error) }));
    child.on('close', (code) => {
      resolve({ ok: true, code: code ?? 1, stdout, stderr });
    });
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

async function runContradictionGuard(prompt: string, success: string): Promise<void> {
  const guardPrompt = buildContradictionGuardPrompt(prompt, success);
  const guardRun = await runJudge(guardPrompt);

  if (!guardRun.ok) {
    terminateWithError(guardRun.error);
  }

  const guard = parseGuardOutput(guardRun.stdout);
  if (!guard.ok) {
    console.error(`Specification blocked: ${guard.reason}`);
    process.exit(3);
  }
}

async function main(): Promise<void> {
  let config: Config;

  try {
    config = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    console.error(message);
    console.error(usage());
    process.exit(2);
  }

  let feedback: string | null = null;


  if (!config.success) {
    const workerPrompt = buildWorkerPrompt(config.prompt, null);
    const workerRun = await runWorker(workerPrompt);
    if (!workerRun.ok) {
      terminateWithError(workerRun.error);
    }
    const workerCode = workerRun.code;
    process.exit(workerCode);
  }


  await runContradictionGuard(config.prompt, config.success);

  for (let i = 1; i <= config.maxIterations; i += 1) {
    console.log(`[Iteration ${i}/${config.maxIterations}] Judge start`);
    const judgePrompt = buildJudgePrompt(config.success);

    const judgeResult = await runJudge(judgePrompt);
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

    const workerRun = await runWorker(workerPrompt);
    if (!workerRun.ok) {
      terminateWithError(workerRun.error);
    }
    const workerCode = workerRun.code;

    console.log(`[Iteration ${i}/${config.maxIterations}] Worker done (exit ${workerCode})`);
  }

  console.log(`\n[Final Check] Judge start`);
  const finalJudge = await runJudge(buildJudgePrompt(config.success));
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
