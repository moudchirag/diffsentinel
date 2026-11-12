import type { ReviewLimits } from "../config/limits.js";
import { AgentLimitExceededError, InvalidModelResponseError } from "../domain/review-errors.js";
import type { ModelReview, ToolCallRecord } from "../domain/review-report.js";
import type { ModelSession, SessionInput, ToolResponse } from "./model-session.js";
import { parseModelReview } from "./report-schema.js";
import { SUBMIT_REVIEW } from "./tool-definitions.js";
import type { ToolRegistry } from "./tool-registry.js";

export interface OrchestratorResult {
  review: ModelReview;
  toolCalls: ToolCallRecord[];
  /** Model turns used (one turn = one model request, excluding transport retries). */
  turns: number;
  /** Raw text returned by tools, used for best-effort evidence verification. */
  toolEvidence: string[];
}

type Limits = Pick<ReviewLimits, "maxAgentIterations" | "maxToolCalls" | "maxToolsPerIteration">;

/**
 * Bounded manual function-calling loop.
 * The model only *requests* tools; this class validates and executes them through the registry,
 * enforces the turn/tool budgets, records a trace, and never claims completion without a valid final review.
 */
export class AgentOrchestrator {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly limits: Limits,
    private readonly log: (message: string) => void = () => {},
    /** How often to print a "still waiting" line while a model request is in flight (0 = never). */
    private readonly heartbeatMs = 10_000,
  ) {}

  /** Sends one model request with live progress, so a slow model never looks like a hung CLI. */
  private async sendWithProgress(session: ModelSession, input: SessionInput, turn: number, lastTurn: boolean) {
    this.log(`[turn ${turn}] waiting for the model${lastTurn ? " (final turn: submit_review required)" : ""}...`);
    const started = Date.now();
    const timer =
      this.heartbeatMs > 0
        ? setInterval(() => this.log(`  ... still waiting for the model (${Math.round((Date.now() - started) / 1000)}s)`), this.heartbeatMs)
        : undefined;
    try {
      return await session.send(input);
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  async run(session: ModelSession, userMessage: string): Promise<OrchestratorResult> {
    const toolCalls: ToolCallRecord[] = [];
    const toolEvidence: string[] = [];
    let input: SessionInput = { kind: "text", text: userMessage };
    let repairsUsed = 0;
    let nudgesUsed = 0;
    let budgetWarned = false;

    for (let turn = 1; turn <= this.limits.maxAgentIterations; turn++) {
      const lastTurn = turn === this.limits.maxAgentIterations;
      const turnStarted = Date.now();
      // On the final turn the model is forced to deliver the review, so a run always ends within its call budget.
      const response = await this.sendWithProgress(
        session,
        lastTurn ? { ...input, forceFunction: SUBMIT_REVIEW } : input,
        turn,
        lastTurn,
      );
      const elapsed = Date.now() - turnStarted;

      const submit = response.functionCalls.find((c) => c.name === SUBMIT_REVIEW);
      if (submit) {
        this.log(`[turn ${turn}] model -> ${SUBMIT_REVIEW} (${elapsed}ms)`);
        try {
          return { review: parseModelReview(submit.args), toolCalls, turns: turn, toolEvidence };
        } catch (error) {
          if (repairsUsed >= 1 || lastTurn) {
            throw new InvalidModelResponseError(`Model returned an invalid review: ${briefZod(error)}`, { cause: error });
          }
          repairsUsed++;
          this.log(`  ! review failed schema validation; asking the model to fix it once`);
          input = {
            kind: "toolResults",
            results: [errorResponse(submit, `Review failed schema validation: ${briefZod(error)}. Call submit_review again with a corrected review.`)],
          };
          continue;
        }
      }

      if (response.functionCalls.length === 0) {
        this.log(`[turn ${turn}] model -> text answer (${elapsed}ms)`);
        const fromText = tryParseJsonReview(response.text);
        if (fromText) return { review: fromText, toolCalls, turns: turn, toolEvidence };
        if (nudgesUsed >= 1 || lastTurn) {
          throw new InvalidModelResponseError("Model did not return a final review (no submit_review call and no valid JSON).");
        }
        nudgesUsed++;
        input = { kind: "text", text: "You must finish by calling submit_review with your structured review. Do it now." };
        continue;
      }

      this.log(
        `[turn ${turn}] model requested ${response.functionCalls.length} tool call(s): ` +
          `${response.functionCalls.map((c) => c.name).join(", ")} (${elapsed}ms)`,
      );
      const results: ToolResponse[] = [];
      for (const [index, call] of response.functionCalls.entries()) {
        if (index >= this.limits.maxToolsPerIteration) {
          this.log(`  - ${call.name} skipped (per-turn limit ${this.limits.maxToolsPerIteration})`);
          results.push(errorResponse(call, `Per-turn limit of ${this.limits.maxToolsPerIteration} tool calls reached; call skipped.`));
          continue;
        }
        if (toolCalls.length >= this.limits.maxToolCalls) {
          if (budgetWarned) {
            throw new AgentLimitExceededError(
              `Model kept requesting tools after the budget of ${this.limits.maxToolCalls} calls was exhausted; review incomplete.`,
            );
          }
          budgetWarned = true;
          this.log(`  - ${call.name} refused: tool budget exhausted`);
          results.push(errorResponse(call, `Tool budget of ${this.limits.maxToolCalls} calls is exhausted. Call submit_review now.`));
          continue;
        }

        const started = Date.now();
        const outcome = await this.registry.execute(call.name, call.args);
        const durationMs = Date.now() - started;
        const summary = outcome.ok ? outcome.summary : outcome.error;
        toolCalls.push({ turn, name: call.name, ok: outcome.ok, target: outcome.target, summary, durationMs });
        this.log(`  ${outcome.ok ? "✓" : "✗"} ${call.name}(${outcome.target}) -> ${summary} [${durationMs}ms]`);

        if (outcome.ok) {
          if (outcome.evidence) toolEvidence.push(outcome.evidence);
          results.push({ ...(call.id ? { id: call.id } : {}), name: call.name, response: { output: outcome.output } });
        } else {
          results.push(errorResponse(call, outcome.error));
        }
      }

      if (lastTurn) break;
      // Let the model plan: on the next (final) turn it must submit. Attached to a real tool response,
      // because providers reject function responses that do not answer a function call.
      const last = results[results.length - 1];
      if (last && this.limits.maxAgentIterations - turn === 1) {
        last.response = { ...last.response, notice: "Next turn is the final one: call submit_review with your review." };
      }
      input = { kind: "toolResults", results };
    }

    throw new AgentLimitExceededError(
      `The model did not deliver a final review within ${this.limits.maxAgentIterations} turn(s); review incomplete.`,
    );
  }
}

function errorResponse(call: { id?: string; name: string }, error: string): ToolResponse {
  return { ...(call.id ? { id: call.id } : {}), name: call.name, response: { error } };
}

function briefZod(error: unknown): string {
  const issues = (error as { issues?: Array<{ path: Array<string | number>; message: string }> }).issues;
  if (issues) return issues.slice(0, 5).map((i) => `${i.path.join(".") || "review"}: ${i.message}`).join("; ");
  return (error as Error).message?.slice(0, 200) ?? "unknown error";
}

function tryParseJsonReview(text: string): ModelReview | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{")) return null;
  try {
    return parseModelReview(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
