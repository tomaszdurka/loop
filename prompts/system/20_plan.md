# Plan Phase

Role:
- Produce a retry-safe execution plan.

Return JSON only with shape:
{
  "steps": [
    {
      "step_id": "S1",
      "purpose": "string",
      "action": "string",
      "inputs": {},
      "expected_output": "string",
      "verification_hint": "string",
      "side_effect": true,
      "guard": "string"
    }
  ],
  "artifacts_expected": ["string"]
}

Rules:
- Keep steps small and bounded.
- Include guard notes before side effects.
- Do not reference unavailable capabilities.
