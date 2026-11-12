# FlexGCC — AI Engineer submission (DRAFT: needs the candidate's own input)

> These sections describe the candidate's *personal* experience, so they are intentionally left for you to fill in.
> Don't paste generic text: the evaluators ask for specific examples of what *you* implemented.

## 1. Candidate information

| Information | Response |
|---|---|
| Full Name | |
| Email / Phone | |
| Current City / Location | |
| LinkedIn / GitHub Profile | |
| Total Professional Experience | |
| Notice Period / Earliest Joining Date | |
| Available for 3-hour daily California working-hours overlap? | Yes / No |

## 2. Technical experience (answer from your real work)

### 1. AI agent development
Problem solved · LLMs/APIs/frameworks/tools · how tool calling + orchestration worked · what *you* built · prototype or deployed.
*Honest option if you have no earlier agent:* DiffSentinel itself (this repo) is a legitimate example — prototype, Gemini + `@google/genai`, manual function-calling loop with a tool registry and hard limits, all of it written/directed by you.

### 2. Technical challenges
What went wrong · how you found the root cause · the change · how you verified. (Real candidates from this project: model returning invalid/prose output → Zod + one repair + terminal `submit_review`; path/secret safety; see README "What went wrong" and add the live-model issues.)

### 3. Full-stack experience (C#/.NET, ASP.NET Core Web API, SQL Server, React)
Feature · what you personally built · how frontend/backend/DB interact · validation, errors, testing.

### 4. Agent reliability & security
One concrete example. (Material from this project: tools are allowlisted + Zod-validated, unknown tools rejected, loop budgets, repository content treated as untrusted data, path/symlink checks, secret exclusion, deterministic risk instead of trusting the model.)

### 5. AI-assisted development & code quality
Tools used (e.g. Claude Code, Copilot, …) · how you verify correctness, security, maintainability, tests. (From this project: spec-first, milestone-by-milestone, typecheck + tests after each step, a test that caught a real bug in AI-written code — the `latest.test.ts` stemming bug.)

## 3. Practical exercise
- README: `README.md`
- Demo: record 2–3 min — `npm run demo:setup`, run the review, point out the `tool ✓ ...` lines, open the JSON report. Do **not** show `.env`.
