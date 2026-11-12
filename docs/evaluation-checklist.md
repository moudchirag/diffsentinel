# DiffSentinel: evaluation checklist

Each item below gives a check, how to verify it, and the evidence from this repository. Items marked *free* use no API key and no network.

## 1. Exercise requirements

| ✓ | Requirement | How to verify | Evidence |
|---|---|---|---|
| ☑ | Reviews a code change: a git diff or a PR | `review` covers uncommitted changes vs `HEAD`; `review --base main` covers a whole branch. For a PR, run `gh pr checkout N`, then `review --base origin/main`. | `src/infrastructure/git/git-cli.provider.ts`, `tests/integration/branch-review.test.ts` |
| ☑ | Structured feedback on **bugs, risks, missing tests, style issues** | Run any review with `--format json`. | Zod schema in `src/agent/report-schema.ts`: `findings` (category `bug` / `security` / `performance` / `reliability`), `missingTests`, `styleIssues`, plus `overallRisk` and `coverage` |
| ☑ | Uses a model and calls tools | Live run (section 3) | Gemini (`gemini-3.5-flash`) through `@google/genai`. Manual function calling with 5 read-only tools and a terminal `submit_review`. |
| ☑ | Public or sample code only | `examples/vulnerable-project` | Synthetic fixture. The `.env` decoy is generated, and its password is fake. |
| ☑ | One-page README: what it does, how it's built, what went wrong, what's next | `README.md` | All four sections are present |
| ☐ | Working demo or screen recording | — | To record: `npm run demo:setup -- branch`, then the live command in section 3 |

## 2. Agent behaviour (tool use and orchestration)

| ✓ | Check | How to verify (*free*) | Evidence |
|---|---|---|---|
| ☑ | The model chooses which context to fetch; the app executes the tools | `npm run dev -- review --cwd .diff-sentinel/demo-repo --provider mock` | `[turn 1] model requested 4 tool call(s): get_imports, find_related_tests, search_repository, read_changed_file` |
| ☑ | Several tool calls in one turn | Same run | 4 calls in turn 1, 2 in turn 2 |
| ☑ | Only tools on the allowlist; Zod validates the arguments | `npm test` | `ToolRegistry` rejects unknown tools and invalid arguments (`tests/integration/tools-and-orchestration.test.ts`) |
| ☑ | Bounded loop: at most 6 turns, 10 tool calls and 4 calls per turn; the final turn forces `submit_review` | `npm test` | `[turn 3] model -> submit_review`, plus the forced-final-turn test |
| ☑ | Invalid report gets one repair attempt; a prose answer gets one nudge | `npm test` | `tests/unit/agent.test.ts` (orchestrator driven by a fake model) |
| ☑ | Hard cap on API requests, retries included | `--max-calls N` | `RequestBudget` test. Live run 2 stopped cleanly when it reached the cap. |
| ☑ | Full trace of every call (turn, tool, target, result, time) | Any run, or `meta` in the JSON | `Agent trace: 3 model turn(s), 6 tool call(s)` |

## 3. Review quality (live, uses the API)

```powershell
npm run demo:setup -- branch
npm run dev -- review --cwd .diff-sentinel/demo-repo --base main --intent "Send transfer receipts by email" --max-calls 3 --out ./.diff-sentinel/review.json
```

| ✓ | Seeded issue | Expected | Run 5 result (`gemini-3.5-flash`) |
|---|---|---|---|
| ☑ | SQL injection (`getAccount`, `findAccountsByOwner`) | critical, `src/accounts.ts` | Found both: critical, lines 10 and 15 |
| ☑ | Amount validation removed | high, `src/transfer.ts` | Found: high, line 5 |
| ☑ | Balance check removed | high, `src/transfer.ts` | Found: high, line 8 |
| ☑ | Debit and credit no longer in one transaction | high, `src/transfer.ts` | Found: high, lines 10–11 |
| ☑ | Fire-and-forget async call | medium, `src/notify.ts` | Found: medium, lines 7–10 |
| ◐ | Missing tests | negative amount, insufficient funds, injection, mail failure | 3 of 4 suggested. Missed the mail-failure test. |
| ☑ | Evidence is real | 0 "could not be matched" warnings | 0 warnings |
| ☑ | No false positives | — | None. Its one style issue, a hard-coded URL, is legitimate. |

Scoring criteria for any run:
- each issue is detected;
- the file and line are correct;
- the quoted evidence exists in the code;
- the severity is reasonable;
- there are no false positives;
- the risk and coverage values are correct.

Full traces are in [`evaluation.md`](evaluation.md). This was one run on a small fixture whose bugs are fairly obvious, so treat it as a smoke test rather than a benchmark.

## 4. Safety and reliability

| ✓ | Check | How to verify (*free*) | Evidence |
|---|---|---|---|
| ☑ | Secrets are never sent | Mock run, or `npx tsx scripts/preview-context.ts .diff-sentinel/demo-repo` | `Skipped files: .env — excluded: environment file (may contain secrets)` |
| ☑ | Path escape is blocked | Mock run | `✗ read_changed_file(../../etc/passwd) -> Path escapes the repository.` |
| ☑ | No shell; read-only | Code review | Fixed `git` argument arrays with `shell:false`. No `run_command` or generic `read_file` tool. The reviewed repository is never modified. |
| ☑ | The model's output is untrusted | `npm test` | Zod validation. Overall risk, coverage and duplicate IDs are computed in code, not taken from the model. |
| ☑ | Prompt injection in the code under review | `src/agent/review-prompt.ts` | Diff and work context are wrapped in `<untrusted_…>` tags, with instructions to treat them as data |
| ☑ | Honest partial coverage | `npm test` | Files that are excluded or over budget are listed, and the report is marked `isPartial` |
| ☑ | Clear errors | Live runs 1 and 4 | HTTP 400, 404, 429 and 503 errors are mapped to actionable messages. Retries are bounded and logged. |

## 5. Engineering quality

| ✓ | Check | Command (*free*) | Result |
|---|---|---|---|
| ☑ | Strict TypeScript | `npm run typecheck` | No errors |
| ☑ | Tests | `npm test` | 6 files; **97 passed, 2 skipped** (the skipped symlink tests need developer mode on Windows) |
| ☑ | Model is replaceable and tests run offline | `ModelClient` / `ModelSession` ports | The orchestrator and use case are tested with fake and scripted models, with no network |
