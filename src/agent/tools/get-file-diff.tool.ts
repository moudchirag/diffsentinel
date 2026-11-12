import { z } from "zod";
import type { ReviewContext } from "../../application/context-builder.js";
import type { GitProvider } from "../../application/ports/git-provider.port.js";
import { UnsafePathError } from "../../domain/review-errors.js";
import { exclusionReason } from "../../infrastructure/filesystem/exclusions.js";
import { redactSecrets } from "../../infrastructure/filesystem/redact.js";
import { RepositoryReader } from "../../infrastructure/filesystem/repository-reader.js";
import type { RegisteredTool } from "../tool-registry.js";

const MAX_DIFF_CHARS = 12_000;
const argsSchema = z.object({ path: z.string().min(1).max(500) }).strict();

/**
 * Returns the unified diff (vs HEAD) for ONE tracked changed file.
 * Mainly useful for files whose diff was left out of the initial context because of size limits.
 */
export function getFileDiffTool(context: ReviewContext, git: GitProvider): RegisteredTool<z.infer<typeof argsSchema>> {
  return {
    declaration: {
      name: "get_file_diff",
      description:
        "Get the unified diff (vs the review base) for ONE tracked changed file. Use it for files listed as skipped " +
        "for size, or to re-check exact +/- lines. Untracked files have no diff: use read_changed_file instead.",
      parametersJsonSchema: {
        type: "object",
        properties: { path: { type: "string", description: "Repository-relative path of a changed file" } },
        required: ["path"],
      },
    },
    schema: argsSchema,
    async handler({ path }) {
      const rel = RepositoryReader.normalize(path);
      const file = context.changedFiles.find((f) => f.path === rel);
      if (!file) throw new UnsafePathError(`"${rel}" is not in the change manifest.`);
      const excluded = exclusionReason(rel);
      if (excluded) throw new UnsafePathError(`"${rel}" is excluded: ${excluded}.`);
      if (file.isBinary) throw new UnsafePathError(`"${rel}" is a binary file.`);
      if (file.status === "untracked") throw new UnsafePathError(`"${rel}" is untracked and has no diff; use read_changed_file.`);

      const { text, redactions } = redactSecrets(await git.getFileDiff(context.repositoryRoot, context.base.commit, file));
      const truncated = text.length > MAX_DIFF_CHARS;
      const diff = truncated ? `${text.slice(0, MAX_DIFF_CHARS)}\n[... diff truncated ...]` : text;
      return {
        target: rel,
        summary: `${diff.split("\n").length} diff line(s)${truncated ? ", truncated" : ""}`,
        evidence: diff,
        output: { path: rel, status: file.status, truncated, ...(redactions ? { warning: `${redactions} value(s) redacted` } : {}), diff },
      };
    },
  };
}
