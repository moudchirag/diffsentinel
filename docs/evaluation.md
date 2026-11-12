# Live evaluation notes

Not a benchmark: a handful of manual runs against the synthetic fixture (`npm run demo:setup -- branch`),
model `gemini-2.5-flash`, under a quota of ~4 requests/hour. Every request is recorded here.

## Expected issues (seeded in `examples/vulnerable-project/change`)

| # | Expected issue | File |
|---|---|---|
| 1 | SQL built by string interpolation / concatenation (`getAccount`, `findAccountsByOwner`) | src/accounts.ts |
| 2 | Amount validation removed (negative / NaN amounts accepted) | src/transfer.ts |
| 3 | Insufficient-balance check removed | src/transfer.ts |
| 4 | Debit + credit no longer in a transaction (partial failure leaves money missing) | src/transfer.ts |
| 5 | Fire-and-forget async call: rejection is unhandled | src/notify.ts |
| 6 | Missing tests: negative amount, insufficient funds, injection input, mail failure | tests |
| – | `.env` decoy must be excluded and never sent | .env |

## Runs (11 Nov 2026 session)

| Run | Requests | Result | What it showed |
|---|---|---|---|
| 1 | 1 | HTTP 400 *"Function calling is not enabled for api version v1"* | SDK 3.2.0 defaults to the `v1` API; function calling needs `v1beta`. Fixed by pinning `apiVersion: "v1beta"`. Not retried (permanent error). |
| 2 | 2 (1× 503 retried silently, 1× OK) | Turn 1 succeeded, then stopped at `--max-calls 2` | **Live tool use works.** Gemini planned and requested 4 tools in parallel across both files; all validated and executed locally; the full tool declarations incl. the `submit_review` JSON schema were accepted (HTTP 200). The hidden retry consumed the budget → retries are now logged. |
| 3 | 1 (503) | Stopped at `--max-calls 1` | Model overloaded (503); retry now visible in the trace; budget cap prevented further spend. |

Run 2 trace (verbatim):

```
Scope: branch "feature/receipts" vs main (merge-base fa739bf): 2 commit(s) + uncommitted changes
Context: 4 changed file(s), 3963 chars sent
[turn 1] model requested 4 tool call(s): get_imports, find_related_tests, find_related_tests, search_repository (5747ms)
  ✓ get_imports(src/transfer.ts) -> 3 of 3 local import(s) read [52ms]
  ✓ find_related_tests(src/accounts.ts) -> 0 related test file(s) [43ms]
  ✓ find_related_tests(src/transfer.ts) -> 1 related test file(s) [43ms]
  ✓ search_repository(findAccountsByOwner) -> 1 match(es) in 1 file(s) [48ms]
ModelRequestError: API request budget of 2 reached (--max-calls); stopping to protect your quota.
```

The tool choices were sensible: it read the contracts `transfer.ts` depends on, looked for tests of both changed
files, and searched for callers of the new `findAccountsByOwner` function.

## Runs with a second key (new project)

| Run | Requests | Result | What it showed |
|---|---|---|---|
| 4 | 1 | HTTP 404 for `gemini-2.5-flash` although `models.list` showed it | Older model not servable for this project. The original 404 mapping hid Google's message → now included. Switched to `gemini-3.5-flash`. |
| 5 | 2 | **Complete review** — exit 0, valid JSON, 37.8 s | Full loop: tools in turn 1, `submit_review` in turn 2. Thought-signature handling (history kept verbatim) worked with a Gemini 3.x model. |

Run 5 trace:

```
Scope: branch "feature/receipts" vs main (merge-base fb1b541): 2 commit(s) + uncommitted changes
[turn 1] model requested 3 tool call(s): read_changed_file, read_changed_file, find_related_tests (17801ms)
  ✓ read_changed_file(src/accounts.ts) -> 17 line(s) [4ms]
  ✓ read_changed_file(src/transfer.ts) -> 15 line(s) [2ms]
  ✓ find_related_tests(src/transfer.ts) -> 1 related test file(s) [53ms]
[turn 2] model -> submit_review (19535ms)
Overall risk: CRITICAL   (6 potential issue(s))  — 2 critical, 3 high, 1 medium; 2 missing tests; 1 style issue
```

## Scoring (run 5, `gemini-3.5-flash`)

Line numbers checked by hand against `examples/vulnerable-project/change`.

| Expected issue | Detected? | Severity | Evidence quality | Correct file/line | Notes |
|---|---|---|---|---|---|
| 1 SQL injection | ✅ (both functions, 2 findings) | critical | exact code lines | ✅ accounts.ts:10, :15 | recommends parameterised queries |
| 2 Amount validation | ✅ | high | function signature (weak but accurate) | ✅ transfer.ts:5 | mentions negative, zero, NaN/Infinity |
| 3 Balance check | ✅ | high | adjacent line | ✅ transfer.ts:8 | |
| 4 Transaction | ✅ | high | both UPDATE lines | ✅ transfer.ts:10-11 | explains partial-failure money loss |
| 5 Unhandled async | ✅ | medium | full function | ✅ notify.ts:7-10 | |
| 6 Missing tests | ✅ partly | high ×2 | – | ✅ files | injection-safe input, negative amount, insufficient funds, rollback; **missed** a mail-failure test |
| `.env` excluded | ✅ | – | – | – | listed as skipped, content never sent |
| False positives | none | – | – | – | 1 style issue (hard-coded URL) is legitimate |

Evidence verification: 0 "could not be matched" warnings. Tool use: read both changed files in full and looked up
existing tests (did not use `search_repository` / `get_imports` this time; run 2 with `gemini-2.5-flash` did).

**Caveat:** one complete run on one small synthetic fixture whose bugs are fairly obvious. It shows the pipeline works
end-to-end and the model can find seeded issues with accurate evidence; it is not evidence of general review quality.
