import path from "node:path";
import { FINDING_CATEGORIES } from "../domain/severity.js";
import type { ReviewFinding } from "../domain/review-finding.js";
import type { ReviewReport } from "../domain/review-report.js";

export function renderJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

const CATEGORY_TITLES: Record<(typeof FINDING_CATEGORIES)[number], string> = {
  bug: "Potential bugs / correctness",
  security: "Security risks",
  reliability: "Reliability & error handling",
  performance: "Performance",
};

function location(f: ReviewFinding): string {
  if (f.lineStart === null) return f.file;
  return f.lineEnd !== null && f.lineEnd !== f.lineStart ? `${f.file}:${f.lineStart}-${f.lineEnd}` : `${f.file}:${f.lineStart}`;
}

export function renderText(report: ReviewReport, repositoryRoot: string): string {
  const out: string[] = [];
  const { coverage, meta } = report;
  out.push("DiffSentinel — Code Review");
  out.push(`Repository: ${path.basename(repositoryRoot)}`);
  out.push(`Scope: ${meta.scope.description}`);
  out.push(`Files changed: ${meta.changedFileCount}   Model: ${meta.model}   Review ID: ${meta.reviewId}`);
  out.push(`Coverage: ${coverage.isPartial ? "PARTIAL" : "Complete"} (${coverage.reviewedFiles.length} reviewed, ${coverage.skippedFiles.length} skipped)`);
  out.push("");
  const requests = meta.apiRequests !== undefined ? `, ${meta.apiRequests} API request(s)` : "";
  out.push(`Agent trace: ${meta.agentTurns} model turn(s), ${meta.toolCalls.length} tool call(s)${requests}, ${(meta.durationMs / 1000).toFixed(1)}s`);
  if (meta.toolCalls.length === 0) out.push("  (no tools requested)");
  for (const t of meta.toolCalls) {
    out.push(`  turn ${t.turn}  ${t.ok ? "✓" : "✗"} ${t.name}(${t.target}) -> ${t.summary}  [${t.durationMs}ms]`);
  }
  out.push(`  turn ${meta.agentTurns}  -> submit_review`);
  out.push("");
  out.push(`Summary: ${report.summary}`);
  out.push(`Overall risk: ${report.overallRisk.toUpperCase()}   (${report.findings.length} potential issue(s))`);

  for (const category of FINDING_CATEGORIES) {
    out.push("");
    out.push(`${CATEGORY_TITLES[category]}:`);
    const items = report.findings.filter((f) => f.category === category);
    if (items.length === 0) out.push("  None");
    for (const f of items) {
      out.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
      out.push(`    File: ${location(f)}`);
      out.push(`    Evidence: ${f.evidence.replace(/\s*\n\s*/g, " ⏎ ").slice(0, 300)}`);
      out.push(`    Why it matters: ${f.description}`);
      out.push(`    Recommendation: ${f.recommendation}`);
      out.push(`    Confidence: ${f.confidence.toFixed(2)}`);
    }
  }

  out.push("");
  out.push("Missing tests:");
  if (report.missingTests.length === 0) out.push("  None");
  for (const t of report.missingTests) out.push(`  [${t.priority.toUpperCase()}] ${t.description} (${t.relatedFile})`);

  out.push("");
  out.push("Style / maintainability:");
  if (report.styleIssues.length === 0) out.push("  None");
  for (const s of report.styleIssues) {
    out.push(`  ${s.file}${s.line !== null ? `:${s.line}` : ""} — ${s.description}`);
    out.push(`    Suggestion: ${s.suggestion}`);
  }

  if (coverage.skippedFiles.length) {
    out.push("");
    out.push("Skipped files:");
    for (const s of coverage.skippedFiles) out.push(`  ${s.path} — ${s.reason}`);
  }
  if (coverage.warnings.length) {
    out.push("");
    out.push("Warnings:");
    for (const w of coverage.warnings) out.push(`  ! ${w}`);
  }

  out.push("");
  out.push(
    meta.model.includes("NOT an AI review")
      ? "Scripted demo run: no code analysis was performed. Use --provider gemini for a real review."
      : "AI-generated review: findings are potential issues. Validate them before acting.",
  );
  return out.join("\n");
}
