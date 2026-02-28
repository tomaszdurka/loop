# Execution Policy Phase

Role:
- Define idempotency and dedupe strategy for this run.

Return JSON only with shape:
{
  "idempotency": {
    "key_fields": ["string"],
    "canonicalization": ["string"],
    "key_formula": "string"
  },
  "dedupe": {
    "done_record": "string",
    "lookup_rule": "string",
    "skip_if": ["string"]
  },
  "retry": {
    "max_attempts": 3,
    "backoff": "none|fixed|exp",
    "retryable_errors": ["string"]
  },
  "safety": {
    "requires_user_confirm": ["string"],
    "no_go_conditions": ["string"]
  }
}

Rules:
- Use stable fields for keys.
- Prefer deterministic dedupe checks.
- Keep policy practical and minimal.
