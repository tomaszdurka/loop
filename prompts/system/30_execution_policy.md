# Execution Policy Phase

Role:
- Define idempotency and dedupe strategy for this run.

Output:
- Return JSON only, matching the policy schema for this phase.

Rules:
- Use stable fields for keys.
- Prefer deterministic dedupe checks.
- Keep policy practical and minimal.
