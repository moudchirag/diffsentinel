import { parseArgs } from "node:util";

export interface CliOptions {
  command: "review" | "help";
  format: "text" | "json";
  out?: string;
  cwd: string;
  provider: "gemini" | "mock";
  /** Hard cap on model API requests (retries included). */
  maxCalls?: number;
  /** Review the whole branch vs this ref (merge-base), like a pull request. */
  base?: string;
  /** Developer-stated purpose of the change. */
  intent?: string;
}

export class UsageError extends Error {}

export const HELP = `DiffSentinel — read-only AI review of your local Git changes

Usage:
  diff-sentinel review [--base <ref>] [--intent <text>] [--format text|json] [--out <file>] [--cwd <dir>]
                       [--max-calls <n>] [--provider gemini|mock]

What is reviewed:
  (default)         uncommitted changes (staged + unstaged + untracked) vs HEAD - "before I commit"
  --base main       the whole branch since it diverged from main: its commits + uncommitted work.
                    This is the same diff a pull request shows. To review a PR, check it out first
                    (e.g. gh pr checkout 123) and run with --base origin/main.

Options:
  --base       Branch/ref to compare against (merge-base), e.g. main or origin/main.
  --intent     What the change is meant to do (max 500 chars); helps separate intended from accidental changes.
  --format     text (default) or json. JSON goes to stdout; progress and the agent trace go to stderr.
  --out        Also write the JSON report to this file.
  --cwd        Repository directory to review (default: current directory).
  --max-calls  Hard cap on Gemini API requests for this run (retries included). The agent is forced to
               submit its review on the last allowed turn. Use it to protect a small quota.
  --provider   gemini (default) or mock. "mock" runs a scripted model that drives every tool offline
               (no API key, no network). It is NOT a code review; use it to rehearse or demo orchestration.
  --help       Show this help.

Never modifies the repository.

PRIVACY NOTICE: with --provider gemini, the selected diff and file contents are sent to the Gemini API.
Use only public or synthetic code, and check your provider's data-handling terms.
Secret redaction is best-effort only.`;

export function parseCliArgs(argv: string[]): CliOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: "string", default: "text" },
        out: { type: "string" },
        cwd: { type: "string" },
        provider: { type: "string", default: "gemini" },
        "max-calls": { type: "string" },
        base: { type: "string" },
        intent: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const base = { cwd: values.cwd ?? process.cwd(), provider: "gemini" as const };
  if (values.help || positionals.length === 0) return { command: "help", format: "text", ...base };
  if (positionals[0] !== "review" || positionals.length > 1) {
    throw new UsageError(`Unknown command "${positionals.join(" ")}". Try: review`);
  }
  if (values.format !== "text" && values.format !== "json") throw new UsageError(`--format must be "text" or "json"`);
  if (values.provider !== "gemini" && values.provider !== "mock") throw new UsageError(`--provider must be "gemini" or "mock"`);

  let maxCalls: number | undefined;
  if (values["max-calls"] !== undefined) {
    maxCalls = Number(values["max-calls"]);
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 20) throw new UsageError("--max-calls must be an integer from 1 to 20");
  }
  if (values.intent !== undefined && (values.intent.trim().length === 0 || values.intent.length > 500)) {
    throw new UsageError("--intent must be 1-500 characters");
  }
  if (values.base !== undefined && values.base.trim().length === 0) throw new UsageError("--base needs a ref, e.g. main");
  return {
    command: "review",
    format: values.format,
    cwd: base.cwd,
    provider: values.provider,
    ...(values.out ? { out: values.out } : {}),
    ...(maxCalls !== undefined ? { maxCalls } : {}),
    ...(values.base ? { base: values.base.trim() } : {}),
    ...(values.intent ? { intent: values.intent.trim() } : {}),
  };
}
