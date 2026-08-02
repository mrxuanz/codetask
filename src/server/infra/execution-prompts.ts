export const EXECUTION_SCOPE_DISCIPLINE = `## Scope discipline
- Treat the user prompt (Description, Success Criteria, Execution Context, or Evidence Bundle) as the only scope boundary — no more, no less.
- Do not expand the work: no unrequested tools, E2E/browser automation, extra test suites, broad refactors, or exploratory commands beyond what the prompt explicitly requires.
- Use the minimum effort and commands needed to satisfy the stated criteria; stop as soon as criteria are met and submit your required MCP verdict immediately.
- High quality means fully landing what the prompt asks for within that boundary — not enlarging the task or verification scope.`
