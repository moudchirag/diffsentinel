import { z } from "zod";
import type { ReviewContext } from "../../application/context-builder.js";
import type { GitProvider } from "../../application/ports/git-provider.port.js";
import { exclusionReason } from "../../infrastructure/filesystem/exclusions.js";
import type { RepositoryReader } from "../../infrastructure/filesystem/repository-reader.js";
import type { RegisteredTool } from "../tool-registry.js";

const MAX_MATCHES = 20;
const MAX_FILES_SCANNED = 2000;
const MAX_LINE_LENGTH = 200;

// Literal text only (no regex from the model => no ReDoS), short, single line.
const argsSchema = z
  .object({ query: z.string().min(2).max(100).refine((q) => !/[\r\n]/.test(q), "query must be a single line") })
  .strict();

/**
 * Finds where a symbol or literal is used across the repository's tracked + untracked (non-ignored) files.
 * Typical use: "who calls getAccount?" to judge the blast radius of a signature/behaviour change.
 */
export function searchRepositoryTool(
  context: ReviewContext,
  git: GitProvider,
  reader: RepositoryReader,
): RegisteredTool<z.infer<typeof argsSchema>> {
  return {
    declaration: {
      name: "search_repository",
      description:
        "Search the repository for a literal, case-sensitive text (e.g. a function name) and return matching lines " +
        `(max ${MAX_MATCHES}). Use it to find callers/usages of changed code. Excluded and binary files are skipped.`,
      parametersJsonSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Literal text to search for, e.g. getAccount" } },
        required: ["query"],
      },
    },
    schema: argsSchema,
    async handler({ query }) {
      const files = (await git.listFiles(context.repositoryRoot))
        .filter((f) => !exclusionReason(f))
        .sort()
        .slice(0, MAX_FILES_SCANNED);
      const allowed = new Set(files);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      let filesSearched = 0;

      for (const file of files) {
        if (matches.length >= MAX_MATCHES) break;
        let content: string;
        try {
          content = (await reader.read(file, allowed)).content;
        } catch {
          continue; // binary, vanished, symlink escape, ... -> silently skipped
        }
        filesSearched++;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
          const line = lines[i] ?? "";
          if (line.includes(query)) matches.push({ path: file, line: i + 1, text: line.trim().slice(0, MAX_LINE_LENGTH) });
        }
      }

      const truncated = matches.length >= MAX_MATCHES;
      return {
        target: query,
        summary: `${matches.length}${truncated ? "+" : ""} match(es) in ${new Set(matches.map((m) => m.path)).size} file(s)`,
        evidence: matches.map((m) => m.text).join("\n"),
        output: { query, filesSearched, truncated, matches },
      };
    },
  };
}
