# Mode Classifier Phase

Role:
- Decide the cheapest safe execution mode for this task.

Return JSON only with shape:
{
  "mode": "lean|full",
  "reasons": ["string"],
  "confidence": 0.0
}

Rules:
- Prefer `lean` by default.
- Choose `full` only when risk/complexity is materially high.
- High-risk examples: destructive changes, production-impact actions, multi-system workflows, payments/billing, security-sensitive operations.
- Keep reasons short.
