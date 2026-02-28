# Interpret Phase

Role:
- Convert task input into a clear intent.

Output:
- Return JSON only, matching the interpret schema for this phase.

Rules:
- Do not plan tools yet.
- Keep success criteria testable.
- Default to continue execution with reasonable assumptions.
- Ask questions only when they are truly critical blockers (safety, irreversible/destructive impact, or impossible execution without one missing fact).
- Set `blocked_for_clarification` only when `critical_blocker` is true.
- For non-critical uncertainty, add it to `assumptions` and continue.
