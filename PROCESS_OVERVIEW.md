# Process Overview (Top-Down)

This document explains how the agentic worker executes tasks at a high level.

## 1) Direction

The system is designed to do one thing reliably:

1. Accept a task.
2. Lease it to one worker.
3. Run the smallest safe pipeline.
4. Mark it done/failed/blocked.
5. Keep an auditable event trail.

Core principle: start lean, expand only when needed.

## 2) Main Flow

1. Intake
- Task is created via API/CLI.
- Task enters `queued` status.

2. Lease
- Worker claims one queued task (`leased` -> `running`).
- Attempt starts with lease TTL + heartbeats.

3. Mode selection pivot
- Source of truth: task `mode` (`lean|full|auto`).
- If `auto`, run tiny classifier prompt to choose `lean` or `full`.

4. Execute selected pipeline
- Lean pipeline: `execute -> verify -> report`
- Full pipeline: `interpret -> plan -> policy -> execute -> verify -> report`

5. Commit
- Attempt is completed.
- Task becomes one of: `done`, `failed`, `blocked`.
- Events and output JSON are persisted.

## 3) Mode Pivot (Critical)

## `lean`
Use when task is straightforward and low-risk.

Steps:
1. `execute`
2. `verify` (or fallback verify if success criteria missing)
3. `report`

Why:
- Lowest token usage.
- Fastest throughput.

## `full`
Use when task is high-risk or structurally complex.

Steps:
1. `interpret`
2. `plan`
3. `policy` (idempotency/dedupe)
4. `execute`
5. `verify`
6. `report`

Why:
- Better control and safety for complicated tasks.

## `auto`
System decides between `lean` and `full` using a tiny classifier prompt.

Classifier intent:
- Prefer `lean` by default.
- Choose `full` only when risk/complexity justifies it.

## 4) Optional Steps and Fallbacks

## Success criteria optional
- `success_criteria` can be omitted.
- In lean mode without success criteria, verify uses execution-status fallback.

## Clarification pivot
- In full mode, `interpret` may request clarification.
- Task is blocked only for critical blockers.
- Non-critical questions are logged and execution continues.

## Dedupe/idempotency
- Used in full mode during `policy`.
- If existing done-record matches idempotency key, task may short-circuit to done.

## 5) Status Outcomes

Final task outcomes:
- `done`: verification passed (or accepted fallback pass in lean).
- `failed`: execution/verification/runtime failed.
- `blocked`: critical missing information/safety blocker.

Intermediate statuses:
- `queued`, `leased`, `running`.

## 6) Observability

You can inspect execution at three levels:

1. Task record
- Current status, attempts, last error.

2. Attempt record
- Final phase and output JSON payload.

3. Event stream
- Ordered phase events (`intake`, `lease`, `mode`, `execute`, etc.).

## 7) Prompts (Control Surface)

Prompts are the behavior layer and are editable:

- `prompts/system/00_executor_base.md`
- `prompts/system/05_mode_classifier.md`
- `prompts/system/10_interpret.md`
- `prompts/system/20_plan.md`
- `prompts/system/30_execution_policy.md`
- `prompts/system/40_verify.md`
- `prompts/system/50_report.md`

Operational rule:
- Tweak behavior in prompt files first.
- Change TypeScript only for lifecycle/infrastructure changes.

## 8) Practical Defaults

Recommended defaults for daily use:

1. Create tasks with `mode=auto`.
2. Use `mode=lean` for simple implementation tasks.
3. Use `mode=full` for risky or multi-system tasks.
4. Provide `success_criteria` when outcome quality matters.

## 9) Failure Direction

When something goes wrong:

1. Check task status and last error.
2. Check latest events by phase.
3. Read attempt `output_json`.
4. Decide: retry, re-queue with `mode=full`, or clarify input.
