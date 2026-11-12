import path from "node:path";
import { z } from "zod";
import type { ReviewContext } from "../../application/context-builder.js";
import type { GitProvider } from "../../application/ports/git-provider.port.js";
import { UnsafePathError } from "../../domain/review-errors.js";
import { exclusionReason } from "../../infrastructure/filesystem/exclusions.js";
import { RepositoryReader } from "../../infrastructure/filesystem/repository-reader.js";
import type { RegisteredTool } from "../tool-registry.js";

const MAX_IMPORTS = 5;
const EXCERPT_BYTES = 3000;
const argsSchema = z.object({ changedFile: z.string().min(1).max(500) }).strict();

const IMPORT_PATTERNS = [
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
  /\b(?:require|import)\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
];

/** Extracts relative import specifiers (JS/TS). Package imports are ignored on purpose. */
export function extractRelativeImports(source: string): string[] {
  const found = new Set<string>();
  for (const re of IMPORT_PATTERNS) {
    for (const m of source.matchAll(re)) if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/** Resolves a relative specifier against known repository files (handles NodeNext ".js" -> ".ts"). */
export function resolveImport(fromFile: string, specifier: string, repoFiles: ReadonlySet<string>): string | null {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base.startsWith("../")) return null;
  const stem = base.replace(/\.(m|c)?js$/, "");
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${stem}.mjs`,
    `${base}/index.ts`,
    `${base}/index.js`,
  ];
  return candidates.find((c) => repoFiles.has(c)) ?? null;
}

/**
 * Returns the local modules a changed file imports, with short excerpts, so the model can check
 * the contracts (types, signatures) the change relies on, without a generic read_file tool.
 */
export function getImportsTool(
  context: ReviewContext,
  git: GitProvider,
  reader: RepositoryReader,
): RegisteredTool<z.infer<typeof argsSchema>> {
  return {
    declaration: {
      name: "get_imports",
      description:
        "List the local (relative) modules imported by ONE changed file and return a short excerpt of each " +
        `(max ${MAX_IMPORTS}). Use it to check types, signatures and contracts the change depends on.`,
      parametersJsonSchema: {
        type: "object",
        properties: { changedFile: { type: "string", description: "Repository-relative path of a changed file" } },
        required: ["changedFile"],
      },
    },
    schema: argsSchema,
    async handler({ changedFile }) {
      const rel = RepositoryReader.normalize(changedFile);
      if (!context.readableFiles.has(rel)) throw new UnsafePathError(`"${rel}" is not a readable changed file.`);
      const source = (await reader.read(rel, context.readableFiles)).content;
      const repoFiles = new Set(await git.listFiles(context.repositoryRoot));
      const specifiers = extractRelativeImports(source);

      const imports: Array<{ specifier: string; path: string | null; excerpt?: string; truncated?: boolean; note?: string }> = [];
      const evidence: string[] = [];
      for (const specifier of specifiers.slice(0, MAX_IMPORTS)) {
        const resolved = resolveImport(rel, specifier, repoFiles);
        if (!resolved) {
          imports.push({ specifier, path: null, note: "could not be resolved to a repository file" });
          continue;
        }
        const excluded = exclusionReason(resolved);
        if (excluded) {
          imports.push({ specifier, path: resolved, note: `excluded: ${excluded}` });
          continue;
        }
        try {
          const f = await reader.read(resolved, new Set([resolved]), EXCERPT_BYTES);
          imports.push({ specifier, path: resolved, excerpt: f.content, truncated: f.truncated });
          evidence.push(f.content);
        } catch (error) {
          imports.push({ specifier, path: resolved, note: (error as Error).message });
        }
      }
      return {
        target: rel,
        summary: `${imports.filter((i) => i.excerpt).length} of ${specifiers.length} local import(s) read`,
        evidence: evidence.join("\n"),
        output: { changedFile: rel, imports, omitted: Math.max(0, specifiers.length - MAX_IMPORTS) },
      };
    },
  };
}
