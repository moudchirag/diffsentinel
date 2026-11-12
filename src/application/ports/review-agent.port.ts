import type { ModelReview, ToolCallRecord } from "../../domain/review-report.js";
import type { ReviewContext } from "../context-builder.js";

export interface AgentResult {
  review: ModelReview;
  /** Orchestration trace: every tool call with turn, outcome and timing. */
  toolCalls: ToolCallRecord[];
  model: string;
  /** Model turns used by the agent loop. */
  turns: number;
  /** Model API requests actually sent (including retries), when known. */
  apiRequests?: number;
  /** Raw text the agent obtained through tools; used for best-effort evidence verification. */
  toolEvidence?: string[];
}

export interface ReviewAgent {
  review(context: ReviewContext): Promise<AgentResult>;
}
