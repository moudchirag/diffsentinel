#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewChangeUseCase } from "../application/review-change.usecase.js";
import type { ModelClient } from "../agent/model-session.js";
import { ToolUsingReviewAgent } from "../agent/review-agent.js";
import { loadConfig } from "../config/env.js";
import { DEFAULT_LIMITS, type ReviewLimits } from "../config/limits.js";
import { DiffSentinelError } from "../domain/review-errors.js";
import { GeminiClient } from "../infrastructure/ai/gemini-client.js";
import { ScriptedDemoModel } from "../infrastructure/ai/scripted-demo-model.js";
import { GitCliProvider } from "../infrastructure/git/git-cli.provider.js";
import { renderJson, renderText } from "./console-reporter.js";
import { HELP, parseCliArgs, UsageError, type CliOptions } from "./parse-args.js";

/** Progress and the agent trace go to stderr so `--format json` keeps stdout machine-readable. */
const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

function createModel(options: CliOptions): ModelClient {
  if (options.provider === "mock") {
    log("Provider: MOCK (scripted, offline). This demonstrates orchestration only; it is not a code review.");
    return new ScriptedDemoModel();
  }
  const config = loadConfig();
  log(`Provider: Gemini (${config.geminiModel})${options.maxCalls ? `, max ${options.maxCalls} API request(s)` : ""}`);
  return new GeminiClient(config.geminiApiKey, config.geminiModel, {
    onRetry: log,
    ...(options.maxCalls ? { maxRequests: options.maxCalls } : {}),
  });
}

async function main(): Promise<number> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === "help") {
    console.log(HELP);
    return 0;
  }

  // Composition root: the only place concrete adapters are wired together.
  const git = new GitCliProvider();
  const root = await git.getRepositoryRoot(options.cwd); // fail fast on "not a repo" before needing API config
  const limits: ReviewLimits = options.maxCalls
    ? { ...DEFAULT_LIMITS, maxAgentIterations: Math.min(DEFAULT_LIMITS.maxAgentIterations, options.maxCalls) }
    : DEFAULT_LIMITS;
  const agent = new ToolUsingReviewAgent(createModel(options), git, limits, log);
  const useCase = new ReviewChangeUseCase(git, agent, limits, log);

  const outcome = await useCase.execute({
    cwd: options.cwd,
    ...(options.base ? { baseRef: options.base } : {}),
    ...(options.intent ? { intent: options.intent } : {}),
  });
  if (outcome.kind === "no-changes") {
    console.log(`No changes found (${outcome.scope}). Nothing to review; no model call was made.`);
    return 0;
  }

  const { report } = outcome;
  if (options.out) {
    const target = path.resolve(options.out);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, renderJson(report), "utf8");
    log(`JSON report written to ${target}`);
  }
  console.log(options.format === "json" ? renderJson(report) : renderText(report, root));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`Usage error: ${error.message}\n\n${HELP}`);
      process.exitCode = 2;
      return;
    }
    console.error(error instanceof DiffSentinelError ? `${error.name}: ${error.message}` : `Unexpected error: ${(error as Error).message}`);
    process.exitCode = 1;
  },
);
