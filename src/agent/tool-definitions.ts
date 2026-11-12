import { z } from "zod";
import type { ReviewContext } from "../application/context-builder.js";
import type { GitProvider } from "../application/ports/git-provider.port.js";
import type { ReviewLimits } from "../config/limits.js";
import type { RepositoryReader } from "../infrastructure/filesystem/repository-reader.js";
import { modelReviewSchema } from "./report-schema.js";
import { findRelatedTestsTool } from "./tools/find-related-tests.tool.js";
import { getFileDiffTool } from "./tools/get-file-diff.tool.js";
import { getImportsTool } from "./tools/get-imports.tool.js";
import { readChangedFileTool } from "./tools/read-changed-file.tool.js";
import { searchRepositoryTool } from "./tools/search-repository.tool.js";
import { ToolRegistry, type ToolDeclaration } from "./tool-registry.js";

export const SUBMIT_REVIEW = "submit_review";

function reviewJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(modelReviewSchema, { io: "input" }) as Record<string, unknown>;
  delete schema["$schema"];
  return schema;
}

/** Terminal "tool": the model delivers its final structured review as arguments. Handled by the orchestrator, never executed. */
export function submitReviewDeclaration(): ToolDeclaration {
  return {
    name: SUBMIT_REVIEW,
    description: "Submit the final structured code review. Call exactly once when the review is complete.",
    parametersJsonSchema: reviewJsonSchema(),
  };
}

/**
 * Builds the registry of executable, read-only tools for one review.
 * Every tool is narrow: it is scoped to the change set or to bounded, excluded-aware repository reads.
 * There is deliberately no generic read_file(path) and no command execution.
 */
export function buildToolRegistry(
  context: ReviewContext,
  git: GitProvider,
  reader: RepositoryReader,
  limits: ReviewLimits,
): ToolRegistry {
  return new ToolRegistry()
    .register(readChangedFileTool(context, reader))
    .register(getFileDiffTool(context, git))
    .register(getImportsTool(context, git, reader))
    .register(searchRepositoryTool(context, git, reader))
    .register(findRelatedTestsTool(context, git, reader, limits));
}
