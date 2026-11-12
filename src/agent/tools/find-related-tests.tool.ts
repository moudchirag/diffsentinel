import { z } from "zod";
import type { ReviewContext } from "../../application/context-builder.js";
import type { GitProvider } from "../../application/ports/git-provider.port.js";
import { UnsafePathError } from "../../domain/review-errors.js";
import type { ReviewLimits } from "../../config/limits.js";
import { findRelatedTests } from "../../infrastructure/filesystem/test-discovery.js";
import { RepositoryReader } from "../../infrastructure/filesystem/repository-reader.js";
import type { RegisteredTool } from "../tool-registry.js";

const argsSchema = z.object({ changedFile: z.string().min(1).max(500) }).strict();
const EXCERPT_BYTES = 3000;

export function findRelatedTestsTool(
  context: ReviewContext,
  git: GitProvider,
  reader: RepositoryReader,
  limits: ReviewLimits,
): RegisteredTool<z.infer<typeof argsSchema>> {
  return {
    declaration: {
      name: "find_related_tests",
      description:
        "Find existing test files that likely cover ONE changed source file (by naming convention), with short excerpts. " +
        "Use it to judge whether the change is tested. Does not run tests.",
      parametersJsonSchema: {
        type: "object",
        properties: { changedFile: { type: "string", description: "Repository-relative path of a changed file" } },
        required: ["changedFile"],
      },
    },
    schema: argsSchema,
    async handler({ changedFile }) {
      const rel = RepositoryReader.normalize(changedFile);
      if (!context.changedFiles.some((f) => f.path === rel)) {
        throw new UnsafePathError(`"${rel}" is not in the change manifest.`);
      }
      const repoFiles = await git.listFiles(context.repositoryRoot);
      const tests = findRelatedTests(rel, repoFiles, limits.maxRelatedTestFiles);
      const allowed = new Set(tests);
      const results: Array<{ path: string; excerpt?: string; truncated?: boolean; note?: string }> = [];
      const evidence: string[] = [];
      for (const t of tests) {
        try {
          const f = await reader.read(t, allowed, EXCERPT_BYTES);
          results.push({ path: t, excerpt: f.content, truncated: f.truncated });
          evidence.push(f.content);
        } catch (error) {
          results.push({ path: t, note: (error as Error).message });
        }
      }
      return {
        target: rel,
        summary: `${results.length} related test file(s)`,
        evidence: evidence.join("\n"),
        output: {
          changedFile: rel,
          relatedTests: results,
          note: results.length === 0 ? "No test files matching naming conventions were found." : undefined,
        },
      };
    },
  };
}
