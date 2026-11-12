import { z } from "zod";
import type { ReviewContext } from "../../application/context-builder.js";
import type { RepositoryReader } from "../../infrastructure/filesystem/repository-reader.js";
import type { RegisteredTool } from "../tool-registry.js";

const MAX_LINES = 400;

const argsSchema = z
  .object({
    path: z.string().min(1).max(500),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .refine((a) => a.startLine === undefined || a.endLine === undefined || a.endLine >= a.startLine, {
    message: "endLine must be >= startLine",
  });

export function readChangedFileTool(
  context: ReviewContext,
  reader: RepositoryReader,
): RegisteredTool<z.infer<typeof argsSchema>> {
  return {
    declaration: {
      name: "read_changed_file",
      description:
        "Read the current (working tree) contents of ONE changed file, with line numbers, to see code surrounding a change. " +
        "Optionally pass startLine/endLine to read only a range. Only files in the change manifest that still exist can be read.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path of a changed file, e.g. src/users.ts" },
          startLine: { type: "integer", description: "Optional first line (1-based)" },
          endLine: { type: "integer", description: "Optional last line (inclusive)" },
        },
        required: ["path"],
      },
    },
    schema: argsSchema,
    async handler({ path, startLine, endLine }) {
      const file = await reader.read(path, context.readableFiles);
      const lines = file.content.split("\n");
      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(lines.length, endLine ?? lines.length, from + MAX_LINES - 1);
      const selected = lines.slice(from - 1, to);
      const numbered = selected.map((line, i) => `${from + i}: ${line}`).join("\n");
      // Only the per-call line cap truncates; asking for lines past the end of the file is not truncation.
      const rangeTruncated = to < Math.min(endLine ?? lines.length, lines.length);
      return {
        target: startLine || endLine ? `${file.path}:${from}-${to}` : file.path,
        summary: `${selected.length} line(s)${file.truncated || rangeTruncated ? ", truncated" : ""}`,
        evidence: selected.join("\n"),
        output: {
          path: file.path,
          lines: `${from}-${to} of ${lines.length}`,
          truncated: file.truncated || rangeTruncated,
          ...(file.redactions ? { warning: `${file.redactions} secret-like value(s) were redacted` } : {}),
          content: numbered,
        },
      };
    },
  };
}
