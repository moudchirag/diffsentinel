import type { MissingTest, ReviewFinding, StyleIssue } from "./review-finding.js";
import type { RiskLevel } from "./severity.js";

/** What the model is responsible for producing. */
export interface ModelReview {
  summary: string;
  findings: ReviewFinding[];
  missingTests: MissingTest[];
  styleIssues: StyleIssue[];
}

export interface Coverage {
  reviewedFiles: string[];
  skippedFiles: Array<{ path: string; reason: string }>;
  warnings: string[];
  isPartial: boolean;
}

export interface ReviewScope {
  mode: "working-tree" | "branch";
  /** "HEAD" or the --base ref, e.g. "main". */
  base: string;
  /** Commit actually diffed against (short hash). */
  baseCommit: string;
  branch: string | null;
  commitCount: number;
  description: string;
}

export interface ReviewMeta {
  reviewId: string;
  model: string;
  scope: ReviewScope;
  generatedAt: string;
  changedFileCount: number;
  durationMs: number;
  /** Number of model turns the agent loop used (one turn = one model request, excluding retries). */
  agentTurns: number;
  /** Model API requests actually sent, including retries, when the provider reports it. */
  apiRequests?: number;
  toolCalls: ToolCallRecord[];
}

/** Final report; `overallRisk` and `coverage` are computed by the application. */
export interface ReviewReport extends ModelReview {
  schemaVersion: 1;
  overallRisk: RiskLevel;
  coverage: Coverage;
  meta: ReviewMeta;
}

/** One entry in the orchestration trace. */
export interface ToolCallRecord {
  /** Model turn (1-based) in which the call was requested. */
  turn: number;
  name: string;
  ok: boolean;
  /** Short, non-sensitive description of the arguments (e.g. the path). */
  target: string;
  /** Short result description, e.g. "3 matches" or the error message. */
  summary: string;
  durationMs: number;
}
