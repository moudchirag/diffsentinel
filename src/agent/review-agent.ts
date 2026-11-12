import type { ReviewContext } from "../application/context-builder.js";
import type { GitProvider } from "../application/ports/git-provider.port.js";
import type { AgentResult, ReviewAgent } from "../application/ports/review-agent.port.js";
import type { ReviewLimits } from "../config/limits.js";
import { RepositoryReader } from "../infrastructure/filesystem/repository-reader.js";
import { AgentOrchestrator } from "./agent-orchestrator.js";
import type { ModelClient } from "./model-session.js";
import { SYSTEM_INSTRUCTION } from "./review-prompt.js";
import { buildToolRegistry, submitReviewDeclaration } from "./tool-definitions.js";

/**
 * ReviewAgent backed by any ModelClient (Gemini in production, a scripted model for demos/tests).
 * Declares the read-only tools, runs the bounded orchestration loop, returns a schema-validated review.
 */
export class ToolUsingReviewAgent implements ReviewAgent {
  constructor(
    private readonly model: ModelClient,
    private readonly git: GitProvider,
    private readonly limits: ReviewLimits,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async review(context: ReviewContext): Promise<AgentResult> {
    const reader = await RepositoryReader.create(context.repositoryRoot, this.limits.maxFileBytes);
    const registry = buildToolRegistry(context, this.git, reader, this.limits);
    const declarations = [...registry.declarations(), submitReviewDeclaration()];
    this.log(`Agent tools: ${declarations.map((d) => d.name).join(", ")}`);
    const session = this.model.startSession({ systemInstruction: SYSTEM_INSTRUCTION, tools: declarations });
    const orchestrator = new AgentOrchestrator(registry, this.limits, this.log);
    const result = await orchestrator.run(session, context.userMessage);
    const apiRequests = this.model.requestsMade?.();
    return {
      review: result.review,
      toolCalls: result.toolCalls,
      model: this.model.modelName,
      turns: result.turns,
      ...(apiRequests !== undefined ? { apiRequests } : {}),
      toolEvidence: result.toolEvidence,
    };
  }
}
