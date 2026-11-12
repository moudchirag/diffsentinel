import type { FindingCategory, Severity } from "./severity.js";

export interface ReviewFinding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  title: string;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  description: string;
  evidence: string;
  recommendation: string;
  /** Model self-reported, uncalibrated. Range 0..1. */
  confidence: number;
}

export interface MissingTest {
  description: string;
  priority: Severity;
  relatedFile: string;
}

export interface StyleIssue {
  file: string;
  line: number | null;
  description: string;
  suggestion: string;
}
