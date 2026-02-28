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
  "artifacts_expected": ["string"],
  "execute_output_format": "json|markdown",
  "execute_output_strict": true,
  "execute_output_schema": {
    "type": "object"
  }
}

Rules:
- Keep steps small and bounded.
- Include guard notes before side effects.
- Do not reference unavailable capabilities.
- Decide execute output contract here (not in policy):
  - `execute_output_format`
  - `execute_output_strict`
  - optional `execute_output_schema` when strict JSON is needed
- For open-ended or creative tasks, keep `execute_output_strict=false`.
