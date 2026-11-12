/**
 * Prints exactly what DiffSentinel would send to the model (no API key or network needed).
 *   npx tsx scripts/preview-context.ts <repo> [--base <ref>] [--intent <text>]
 */
import { parseArgs } from "node:util";
import { ContextBuilder } from "../src/application/context-builder.js";
import { DEFAULT_LIMITS } from "../src/config/limits.js";
import { RepositoryReader } from "../src/infrastructure/filesystem/repository-reader.js";
import { GitCliProvider } from "../src/infrastructure/git/git-cli.provider.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { base: { type: "string" }, intent: { type: "string" } },
});
const cwd = positionals[0] ?? process.cwd();
const git = new GitCliProvider();
const snapshot = await git.collectWorkingTreeDiff(cwd, values.base ? { baseRef: values.base } : {});
const reader = await RepositoryReader.create(snapshot.repositoryRoot, DEFAULT_LIMITS.maxFileBytes);
const ctx = await new ContextBuilder(git, reader, DEFAULT_LIMITS).build(snapshot, values.intent ? { intent: values.intent } : {});
console.log(ctx.userMessage);
console.error(`\n[${ctx.userMessage.length} chars | partial=${ctx.coverage.isPartial} | readable=${[...ctx.readableFiles].join(", ")}]`);
