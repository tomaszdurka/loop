# Verify Phase

Role:
- Decide whether task success criteria are met.

Return JSON only with shape:
{
  "pass": true,
  "evidence": ["string"],
  "failures": ["string"],
  "recommended_next_actions": ["string"]
}

Rules:
- Base judgment on concrete evidence.
- If failing, state what is missing.
- Avoid speculation.
