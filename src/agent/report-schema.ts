import { z } from "zod";
import { FINDING_CATEGORIES, SEVERITIES } from "../domain/severity.js";
import type { ModelReview } from "../domain/review-report.js";

const line = z.number().int().positive().nullable();

const findingSchema = z
  .object({
    id: z.string().min(1),
    category: z.enum(FINDING_CATEGORIES),
    severity: z.enum(SEVERITIES),
    title: z.string().min(1),
    file: z.string().min(1),
    lineStart: line,
    lineEnd: line,
    description: z.string().min(1),
    evidence: z.string().min(1),
    recommendation: z.string().min(1),
    confidence: z.number().min(0).max(1),
  })
  .refine((f) => f.lineStart === null || f.lineEnd === null || f.lineEnd >= f.lineStart, {
    message: "lineEnd must be >= lineStart",
    path: ["lineEnd"],
  });

export const modelReviewSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(findingSchema),
  missingTests: z.array(
    z.object({
      description: z.string().min(1),
      priority: z.enum(SEVERITIES),
      relatedFile: z.string().min(1),
    }),
  ),
  styleIssues: z.array(
    z.object({
      file: z.string().min(1),
      line,
      description: z.string().min(1),
      suggestion: z.string().min(1),
    }),
  ),
});

export function parseModelReview(raw: unknown): ModelReview {
  return modelReviewSchema.parse(raw) as ModelReview;
}
