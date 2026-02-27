import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CompiledResponsibility = {
  description: string;
  everyMs: number;
  sourceKind: string;
  cursorKey: string | null;
  dedupeTemplate: string;
  runtimeRequirements: Record<string, unknown>;
  taskType: string;
  taskTitle: string;
  taskPrompt: string;
  contract: Record<string, unknown>;
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOOP_ENTRYPOINT = resolve(PROJECT_ROOT, 'src', 'loop.ts');
const COMPILER_PROMPT_PATH = resolve(PROJECT_ROOT, 'prompts', 'system', 'responsibility-compiler.md');

function readCompilerPrompt(): string {
  return readFileSync(COMPILER_PROMPT_PATH, 'utf8').trim();
}

function buildCompilePrompt(id: string, intentPrompt: string): string {
  const compilerPrompt = readCompilerPrompt();
  return [
    'Use the following compiler instructions exactly.',
    '',
    compilerPrompt,
    '',
    'Now compile this responsibility intent:',
    `RESPONSIBILITY_ID: ${id}`,
    `INTENT_PROMPT: ${intentPrompt}`,
    '',
    'Output a practical free-form compilation (concise).',
    'Do not force rigid schemas.',
    'Explicitly include these decisions in your text:',
    '- recommended run cadence',
    '- what state should persist between runs',
    '- duplicate prevention strategy',
    '- how discovered items should become concrete tasks'
  ].join('\n');
}

function runLoopCompile(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const provider = process.env.RESPONSIBILITY_COMPILER_PROVIDER === 'claude' ? 'claude' : 'codex';
    const args = ['tsx', LOOP_ENTRYPOINT, 'run', prompt, '--provider', provider, '--max-iterations', '1', '--cwd', PROJECT_ROOT];
    const child = spawn('npx', args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`loop run failed (exit ${code})\n${stderr || stdout}`));
        return;
      }
      resolve((stdout || '').trim());
    });
  });
}

function parseEveryMsFromText(text: string): number {
  const t = text.toLowerCase();

  if (/(hourly|every\s+hour|each\s+hour)/.test(t)) {
    return 60 * 60 * 1000;
  }
  if (/(daily|every\s+day|each\s+day)/.test(t)) {
    return 24 * 60 * 60 * 1000;
  }

  const match = t.match(/every\s+(\d+)\s*(minute|minutes|min|hour|hours|day|days)/);
  if (!match) {
    return 60 * 60 * 1000;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 60 * 60 * 1000;
  }
  const unit = match[2];
  if (unit.startsWith('min')) {
    return value * 60 * 1000;
  }
  if (unit.startsWith('hour')) {
    return value * 60 * 60 * 1000;
  }
  return value * 24 * 60 * 60 * 1000;
}

function toCompiledResponsibility(id: string, intentPrompt: string, compilationText: string): CompiledResponsibility {
  const description = `Compiled responsibility from intent: ${intentPrompt.slice(0, 120)}`;
  const everyMs = parseEveryMsFromText(`${intentPrompt}\n${compilationText}`);

  const sourceKind = 'generic';
  const cursorKey = null;
  const dedupeTemplate = `responsibility:${id}:{source_item_id}`;
  const taskType = 'proactive-scan';
  const taskTitle = `Responsibility run: ${id}`;

  const taskPrompt = [
    `Responsibility intent: ${intentPrompt}`,
    '',
    'Compiled guidance:',
    compilationText || '(no compiler output; use intent directly)',
    '',
    'Run objective:',
    '- Detect actionable items for this cycle.',
    '- Convert actionable findings into concrete tasks.',
    '- Preserve source details and avoid duplicates.'
  ].join('\n');

  const runtimeRequirements: Record<string, unknown> = {
    compile_mode: 'reasoning_freeform',
    notes: compilationText,
    inferred_cadence_ms: everyMs
  };

  const contract: Record<string, unknown> = {
    version: 1,
    responsibility_id: id,
    intent_prompt: intentPrompt,
    compiled_at: new Date().toISOString(),
    runtime_requirements: runtimeRequirements,
    compiler_output: compilationText
  };

  return {
    description,
    everyMs,
    sourceKind,
    cursorKey,
    dedupeTemplate,
    runtimeRequirements,
    taskType,
    taskTitle,
    taskPrompt,
    contract
  };
}

export async function compileResponsibilityPrompt(id: string, prompt: string): Promise<CompiledResponsibility> {
  const intentPrompt = prompt.trim();
  const compilePrompt = buildCompilePrompt(id, intentPrompt);
  const compilerOutput = await runLoopCompile(compilePrompt);
  return toCompiledResponsibility(id, intentPrompt, compilerOutput);
}
