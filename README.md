# DiffSentinel — AI code-review agent

DiffSentinel reviews your **local Git changes** (staged + unstaged vs `HEAD`, plus untracked files) and returns structured feedback: potential **bugs**, **security / reliability / performance risks**, **missing tests**, and **style issues**. It is a *read-only, tool-using agent*: Gemini plans what context it is missing and requests it through five declared tools (often several in parallel in one turn); the application — not the model — validates and runs them, under hard budgets, and records an orchestration trace. Output is a readable terminal report and/or a Zod-validated JSON report.

**What gets reviewed**

| Developer wants to review… | Command | Compared against |
|---|---|---|
| uncommitted work, before committing | `review` | `HEAD` (staged + unstaged + untracked) |
| the whole branch | `review --base main` | merge-base with `main`: all branch commits + uncommitted work |
| a pull request | `gh pr checkout 123` then `review --base origin/main` | the same merge-base diff GitHub shows |

In branch mode the branch name and commit messages are sent as *work context*, and `--intent "…"` adds the developer's stated purpose, so the model can tell intended changes from accidental ones (it is told an intended change can still be risky).

> **Privacy:** the selected diff/file contents are sent to the Gemini API. Use public or synthetic code only. Secret redaction is best-effort, not a guarantee.

## How it is built

TypeScript (strict) on Node 22+, official `@google/genai` SDK, Zod, Vitest. No agent framework — the loop is ~100 lines in [`src/agent/agent-orchestrator.ts`](src/agent/agent-orchestrator.ts).

- **Git adapter** (`execFile`, `shell:false`, fixed args): per-file `diff <base>`, `--name-status -z` / `--numstat -z` for status/rename/binary detection, `ls-files --others --exclude-standard` for untracked files, `merge-base` + `log` for branch mode. `--base` is validated and passed after `--end-of-options`. Works before the first commit.
- **Context builder**: sends a manifest + per-file diffs under size budgets; excluded (secrets, lockfiles, binaries) and over-budget files are *listed as skipped* and the report is marked **partial** instead of silently claiming full coverage.
- **Tools** — all read-only, allowlisted, path-normalised, symlink/root-checked, size-limited; no shell, no generic `read_file`:

  | Tool | Why the reviewer needs it |
  |---|---|
  | `read_changed_file(path, startLine?, endLine?)` | code around a change, real line numbers |
  | `get_file_diff(path)` | exact diff of one file, incl. files skipped for size |
  | `get_imports(changedFile)` | contracts/types of local modules the change relies on |
  | `search_repository(query)` | callers/usages of changed code (literal search, no regex → no ReDoS) |
  | `find_related_tests(changedFile)` | existing tests, to judge what is missing |

- **Orchestration**: manual function calling — SDK auto-execution is disabled. Each turn the model may request several tools in parallel; the **registry** rejects unknown tools and validates args with Zod; the **orchestrator** enforces budgets (≤6 turns, ≤10 tool calls, ≤4 per turn), sends `functionResponse`s back, warns the model before its last turn and on the last turn *forces* it (function-calling mode `ANY`) to call the terminal `submit_review`, whose arguments are Zod-validated (one repair allowed). `--max-calls N` is a hard cap on API requests, retries included. Every call is traced (turn, tool, target, result, ms) live on stderr and in the JSON.
- **Offline mode**: `--provider mock` swaps in a scripted model through the same `ModelClient` port. It drives every tool — including one deliberately unsafe path that the guardrails reject — with zero API calls. It performs no analysis and says so; it exists to rehearse and to test orchestration.
- **Deterministic parts**: overall risk (highest severity), coverage, duplicate ids, and warnings for evidence that can't be found in what the model saw — computed in application code, not trusted from the model.
- Layers: CLI → use case → ports (`GitProvider`, `ReviewAgent`) → adapters; details in [`docs/architecture.md`](docs/architecture.md).

## Run it

Prereqs: Node 22+, Git, a Gemini API key.

```powershell
npm install
copy .env.example .env        # then set GEMINI_API_KEY and GEMINI_MODEL
npm run demo:setup            # synthetic repo with an uncommitted "bad change" in .diff-sentinel/demo-repo
npm run dev -- review --cwd .diff-sentinel/demo-repo --provider mock                 # free rehearsal, no API
npm run dev -- review --cwd .diff-sentinel/demo-repo --max-calls 3 --out ./.diff-sentinel/review.json

npm run demo:setup -- branch  # same change as 2 commits on feature/receipts (PR-style) + uncommitted WIP
npm run dev -- review --cwd .diff-sentinel/demo-repo --base main --intent "Send transfer receipts by email" --max-calls 3
npm run typecheck ; npm test
```

`npm run dev -- review` inside any repo reviews that repo. The agent trace (`[turn 1] model requested 3 tool call(s) …`, `✓ search_repository(getAccount) -> 4 match(es)`) goes to stderr; `--format json` keeps stdout pure JSON. Without a key you can still see exactly what would be sent: `npx tsx scripts/preview-context.ts <repo>`.

The demo fixture (`examples/vulnerable-project`) is synthetic: SQL built by string interpolation, removed amount/balance validation, non-atomic debit/credit (transaction removed), a fire-and-forget async call, and an untracked `.env` decoy that must be excluded.

## What went wrong and how it was handled

- **Vitest failed on every file ("failed to find the runner")** — caused by a lowercase `z:\` drive letter in the shell cwd making Vitest load two copies of itself. Found by running a one-line test from an uppercase path; fixed with a tiny launcher (`scripts/run-vitest.mjs`) that normalises the drive letter.
- **Test discovery bug** — my first stemming rule turned `latest.test.ts` into `la`, so it never matched `latest.ts`. A unit test caught it; the affix is now only stripped after a separator or CamelCase boundary.
- **"Not a repo" test passed the wrong way** — the machine's home directory is itself a Git repo, so a temp folder resolved to it. The test now sets `GIT_CEILING_DIRECTORIES`.
- **Untracked files and secrets** — `git diff` omits untracked files and would happily diff a changed `.env`, so the app collects untracked files separately and applies exclusions *before* any diff text is fetched.
- **Windows symlinks** — creating symlinks needs developer mode, so the two symlink-escape tests skip when they can't be created (they run elsewhere).
- **A 4-requests-per-hour quota** — each model turn is an API request, so an unbounded loop could burn the quota without producing a review. Fixes: parallel tool calls per turn, a hard `--max-calls` request budget (retries count), and forcing `submit_review` on the last allowed turn. A scripted mock model made it possible to rehearse the whole loop for free.
- **"Truncated" false alarm** — the rehearsal showed `read_changed_file` reporting truncation when the requested range simply ran past the end of the file; fixed and covered by a regression test.
- **First live call: HTTP 400** — `@google/genai` 3.2.0 defaults to the `v1` API, which rejects function calling. Found from the error text, confirmed in the SDK source, fixed by pinning `apiVersion: "v1beta"`.
- **Model overload (503) silently ate the quota** — my bounded retry worked, but invisibly, so one turn cost two requests and the budget ran out before the final turn. Retries are now logged in the trace and count against `--max-calls`, which stopped the run cleanly instead of overspending.
- **404 for a listed model** — with a new key, `gemini-2.5-flash` appeared in `models.list` but returned 404 on generation. My error mapping had replaced Google's message with a generic one; it now keeps it. Switched to `gemini-3.5-flash`, which also exercised Gemini 3 thought signatures (handled by keeping model turns verbatim in history).
- **Result** — first complete run: 2 API requests, 3 parallel tool calls, forced `submit_review`, **6/6 seeded issues found** with correct files/lines and verified evidence, no false positives; it missed one suggested test. One run on an easy synthetic fixture — a smoke test, not a benchmark. Details: [`docs/evaluation.md`](docs/evaluation.md); tick-box version with how-to-verify commands: [`docs/evaluation-checklist.md`](docs/evaluation-checklist.md).

## What I would do next

review a PR without checking it out (tools would read file contents from Git objects at the PR head instead of the working tree) and post findings as PR comments via a least-privilege GitHub App; richer, language-aware test discovery and AST-based context; a small labelled evaluation set so prompt/model changes can be regression-tested; stronger secret scanning before upload; a second `ReviewAgent` adapter (another provider) behind the existing port; CI mode with severity thresholds.
