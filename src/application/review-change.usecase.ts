import { randomBytes } from "node:crypto";
import type { ReviewLimits } from "../config/limits.js";
import { calculateOverallRisk, SEVERITIES } from "../domain/severity.js";
import type { ReviewFinding } from "../domain/review-finding.js";
import type { ReviewReport } from "../domain/review-report.js";
import { RepositoryReader } from "../infrastructure/filesystem/repository-reader.js";
import { ContextBuilder, describeScope, type ReviewContext } from "./context-builder.js";
import type { GitProvider } from "./ports/git-provider.port.js";
import type { ReviewAgent } from "./ports/review-agent.port.js";

export interface ReviewRequest {
  cwd: string;
  /** Review the whole branch vs this ref (merge-base), like a pull request. Omit for uncommitted changes vs HEAD. */
  baseRef?: string;
  /** Optional developer-stated purpose of the change. */
  intent?: string;
}

export type ReviewOutcome =
  | { kind: "no-changes"; repositoryRoot: string; scope: string }
  | { kind: "reviewed"; report: ReviewReport };

/** Strips diff markers / line-number prefixes and collapses whitespace so evidence can be matched loosely. */
export function canonicalize(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, "").replace(/^[+-](?![+-]{2})/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export class ReviewChangeUseCase {
  constructor(
    private readonly git: GitProvider,
    private readonly agent: ReviewAgent,
    private readonly limits: ReviewLimits,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async execute(request: ReviewRequest): Promise<ReviewOutcome> {
    const started = Date.now();
    const reviewId = randomBytes(4).toString("hex");

    this.log("Collecting changes from Git...");
    const snapshot = await this.git.collectWorkingTreeDiff(request.cwd, request.baseRef ? { baseRef: request.baseRef } : {});
    const scope = describeScope(snapshot.base, snapshot.branch, snapshot.commits.length);
    this.log(`Scope: ${scope}`);
    if (snapshot.changedFiles.length === 0) return { kind: "no-changes", repositoryRoot: snapshot.repositoryRoot, scope };

    const reader = await RepositoryReader.create(snapshot.repositoryRoot, this.limits.maxFileBytes);
    const context = await new ContextBuilder(this.git, reader, this.limits).build(
      snapshot,
      request.intent ? { intent: request.intent } : {},
    );
    this.log(
      `Context: ${snapshot.changedFiles.length} changed file(s), ${context.userMessage.length} chars sent` +
        (context.coverage.isPartial ? " (PARTIAL coverage)" : ""),
    );

    this.log("Asking the model to review (it may request tools)...");
    const result = await this.agent.review(context);

    const warnings = [...context.coverage.warnings];
    const findings = this.normalizeFindings(result.review.findings, context, result.toolEvidence ?? [], warnings);
    if (findings.length === 0 && context.coverage.isPartial) {
      warnings.push("No findings were reported, but coverage is partial: this is NOT evidence that the change is safe.");
    }
    if (result.toolCalls.length === 0) {
      warnings.push("The model reviewed the diff without requesting additional context from tools.");
    }

    const report: ReviewReport = {
      schemaVersion: 1,
      summary: result.review.summary,
      overallRisk: calculateOverallRisk(findings),
      findings,
      missingTests: result.review.missingTests,
      styleIssues: result.review.styleIssues,
      coverage: { ...context.coverage, warnings },
      meta: {
        reviewId,
        model: result.model,
        scope: {
          mode: snapshot.base.mode,
          base: snapshot.base.ref,
          baseCommit: snapshot.base.commit.slice(0, 7),
          branch: snapshot.branch,
          commitCount: snapshot.commits.length,
          description: scope,
        },
        generatedAt: new Date().toISOString(),
        changedFileCount: snapshot.changedFiles.length,
        durationMs: Date.now() - started,
        agentTurns: result.turns,
        ...(result.apiRequests !== undefined ? { apiRequests: result.apiRequests } : {}),
        toolCalls: result.toolCalls,
      },
    };
    return { kind: "reviewed", report };
  }

  /** Enforces invariants that depend on repository state; records warnings instead of silently dropping findings. */
  private normalizeFindings(
    findings: ReviewFinding[],
    context: ReviewContext,
    toolEvidence: string[],
    warnings: string[],
  ): ReviewFinding[] {
    const changed = new Set(context.changedFiles.map((f) => f.path));
    const corpus = canonicalize([...context.seenText, ...toolEvidence].join("\n"));
    const seenIds = new Set<string>();

    const normalized = findings.map((f, index) => {
      let id = f.id;
      if (seenIds.has(id)) id = `${id}-${index + 1}`;
      seenIds.add(id);
      const file = f.file.replaceAll("\\", "/").replace(/^\.\//, "");
      if (!changed.has(file)) {
        warnings.push(`Finding "${f.title}" refers to ${file}, which is not part of the change set.`);
      }
      const evidence = canonicalize(f.evidence);
      if (evidence.length > 0 && !corpus.includes(evidence)) {
        warnings.push(`Evidence for "${f.title}" could not be matched verbatim against the reviewed content; verify manually.`);
      }
      return { ...f, id, file };
    });

    return normalized.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  }
}
