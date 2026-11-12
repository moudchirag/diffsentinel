# DiffSentinel — project notes for Claude Code

Read-only, tool-using AI code-review CLI (TypeScript, Node 22+, `@google/genai`, Zod, Vitest). See README.md and docs/architecture.md.

## Commands
- `npm run typecheck` · `npm test` (uses scripts/run-vitest.mjs; do not call `vitest` directly on Windows with a lowercase drive letter)
- `npm run demo:setup` then `npm run dev -- review --cwd .diff-sentinel/demo-repo`
- `npx tsx scripts/preview-context.ts <repo>` shows exactly what would be sent to the model (no API key needed)

## Rules
- Never read, print, log or commit `.env` / the API key. Fixtures are synthetic only.
- The reviewer is read-only. The only process execution is fixed `git` argument arrays with `shell:false`.
- Do not add a generic `read_file` / `run_command` tool. Tools must stay allowlisted, path-checked and size-limited.
- Model output (reports, tool args) is untrusted: validate with Zod; compute risk/coverage in application code.
- Keep the `ModelSession` abstraction: the orchestrator is tested with a fake model, no network.
