import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentOrchestrator } from "../../src/agent/agent-orchestrator.js";
import type { ModelSession, SessionInput } from "../../src/agent/model-session.js";
import { ToolUsingReviewAgent } from "../../src/agent/review-agent.js";
import { buildToolRegistry } from "../../src/agent/tool-definitions.js";
import { extractRelativeImports, resolveImport } from "../../src/agent/tools/get-imports.tool.js";
import { ContextBuilder, type ReviewContext } from "../../src/application/context-builder.js";
import { ReviewChangeUseCase } from "../../src/application/review-change.usecase.js";
import { parseCliArgs, UsageError } from "../../src/cli/parse-args.js";
import { renderText } from "../../src/cli/console-reporter.js";
import { DEFAULT_LIMITS } from "../../src/config/limits.js";
import { RequestBudget } from "../../src/infrastructure/ai/gemini-client.js";
import { ScriptedDemoModel } from "../../src/infrastructure/ai/scripted-demo-model.js";
import { RepositoryReader } from "../../src/infrastructure/filesystem/repository-reader.js";
import { GitCliProvider } from "../../src/infrastructure/git/git-cli.provider.js";
import { commitAll, createTempRepo, removeDir, writeRepoFile } from "../helpers/temp-repo.js";

const git = new GitCliProvider();
let root: string;

/** Baseline + an uncommitted change that touches imports, callers, tests, an untracked file and a secret. */
async function seedRepo(): Promise<void> {
  await writeRepoFile(root, "src/db.ts", "export interface Db { query(sql: string): Promise<unknown[]> }\n");
  await writeRepoFile(root, "src/accounts.ts", 'import type { Db } from "./db.js";\nexport async function getAccount(db: Db, id: string) {\n  return db.query("SELECT 1");\n}\n');
  await writeRepoFile(root, "src/report.ts", 'import { getAccount } from "./accounts.js";\nexport const r = getAccount;\n');
  await writeRepoFile(root, "tests/accounts.test.ts", 'import { getAccount } from "../src/accounts.js";\ntest("x", () => getAccount);\n');
  await writeRepoFile(root, ".env", "TOKEN=committed-by-mistake\n");
  commitAll(root);
  await writeRepoFile(root, "src/accounts.ts", 'import type { Db } from "./db.js";\nexport async function getAccount(db: Db, id: string) {\n  return db.query(`SELECT * FROM a WHERE id = ${id}`);\n}\n');
  await writeRepoFile(root, ".env", "TOKEN=changed-secret-value\n");
  await writeRepoFile(root, "src/new-helper.ts", "export const helper = () => 42;\n");
}

async function buildContext(): Promise<{ ctx: ReviewContext; reader: RepositoryReader }> {
  const snap = await git.collectWorkingTreeDiff(root);
  const reader = await RepositoryReader.create(snap.repositoryRoot, DEFAULT_LIMITS.maxFileBytes);
  return { ctx: await new ContextBuilder(git, reader, DEFAULT_LIMITS).build(snap), reader };
}

beforeEach(async () => {
  root = await createTempRepo();
  await seedRepo();
});
afterEach(async () => {
  await removeDir(root);
});

describe("tools", () => {
  async function registry() {
    const { ctx, reader } = await buildContext();
    return buildToolRegistry(ctx, git, reader, DEFAULT_LIMITS);
  }

  it("declares exactly the five read-only tools", async () => {
    const reg = await registry();
    expect(reg.declarations().map((d) => d.name).sort()).toEqual(
      ["find_related_tests", "get_file_diff", "get_imports", "read_changed_file", "search_repository"].sort(),
    );
  });

  it("read_changed_file supports line ranges", async () => {
    const out = await (await registry()).execute("read_changed_file", { path: "src/accounts.ts", startLine: 2, endLine: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.target).toBe("src/accounts.ts:2-3");
    const content = (out.output as { content: string }).content;
    expect(content.startsWith("2: export async function getAccount")).toBe(true);
    expect(content).not.toContain("import type");
  });

  it("read_changed_file does not report truncation when the range runs past the end of the file", async () => {
    const out = await (await registry()).execute("read_changed_file", { path: "src/new-helper.ts", startLine: 1, endLine: 50 });
    if (!out.ok) throw new Error(out.error);
    expect((out.output as { truncated: boolean }).truncated).toBe(false);
    expect(out.summary).not.toMatch(/truncated/);
  });

  it("search_repository finds callers, skips excluded files, and treats the query literally", async () => {
    const reg = await registry();
    const out = await reg.execute("search_repository", { query: "getAccount" });
    if (!out.ok) throw new Error(out.error);
    const matches = (out.output as { matches: Array<{ path: string }> }).matches.map((m) => m.path);
    expect(new Set(matches)).toEqual(new Set(["src/accounts.ts", "src/report.ts", "tests/accounts.test.ts"]));

    const secret = await reg.execute("search_repository", { query: "TOKEN=" });
    if (!secret.ok) throw new Error(secret.error);
    expect((secret.output as { matches: unknown[] }).matches).toEqual([]); // .env never searched

    const regexy = await reg.execute("search_repository", { query: ".*" });
    if (!regexy.ok) throw new Error(regexy.error);
    expect((regexy.output as { matches: unknown[] }).matches).toEqual([]); // literal, not a regex

    expect((await reg.execute("search_repository", { query: "a\nb" })).ok).toBe(false);
  });

  it("get_imports resolves NodeNext '.js' specifiers to .ts files and returns excerpts", async () => {
    const out = await (await registry()).execute("get_imports", { changedFile: "src/accounts.ts" });
    if (!out.ok) throw new Error(out.error);
    const imports = (out.output as { imports: Array<{ path: string; excerpt?: string }> }).imports;
    expect(imports).toEqual([expect.objectContaining({ path: "src/db.ts", excerpt: expect.stringContaining("interface Db") })]);
  });

  it("get_imports refuses files outside the change set", async () => {
    const out = await (await registry()).execute("get_imports", { changedFile: "src/report.ts" });
    expect(out.ok).toBe(false);
  });

  it("get_file_diff returns tracked diffs and refuses untracked/excluded/unknown files", async () => {
    const reg = await registry();
    const ok = await reg.execute("get_file_diff", { path: "src/accounts.ts" });
    if (!ok.ok) throw new Error(ok.error);
    expect((ok.output as { diff: string }).diff).toContain("+  return db.query(`SELECT * FROM a WHERE id = ${id}`);");
    expect((await reg.execute("get_file_diff", { path: "src/new-helper.ts" })).ok).toBe(false);
    expect((await reg.execute("get_file_diff", { path: ".env" })).ok).toBe(false);
    expect((await reg.execute("get_file_diff", { path: "src/report.ts" })).ok).toBe(false);
  });

  it("extractRelativeImports / resolveImport handle common forms", () => {
    const src = [
      'import a from "./a.js";',
      "import { b } from '../lib/b';",
      'export * from "./c";',
      'import "./side-effect.js";',
      'const d = require("./d");',
      'const e = await import("./e.js");',
      'import fs from "node:fs";',
      'import x from "lodash";',
    ].join("\n");
    expect(extractRelativeImports(src).sort()).toEqual(["../lib/b", "./a.js", "./c", "./d", "./e.js", "./side-effect.js"]);
    const files = new Set(["src/a.ts", "lib/b.ts", "src/c/index.ts"]);
    expect(resolveImport("src/x.ts", "./a.js", files)).toBe("src/a.ts");
    expect(resolveImport("src/x.ts", "../lib/b", files)).toBe("lib/b.ts");
    expect(resolveImport("src/x.ts", "./c", files)).toBe("src/c/index.ts");
    expect(resolveImport("src/x.ts", "../../outside", files)).toBeNull();
  });
});

describe("orchestration", () => {
  it("forces submit_review on the final turn so a run always ends within its budget", async () => {
    const { ctx, reader } = await buildContext();
    const reg = buildToolRegistry(ctx, git, reader, DEFAULT_LIMITS);
    const inputs: SessionInput[] = [];
    const session: ModelSession = {
      async send(input) {
        inputs.push(input);
        if (input.forceFunction === "submit_review") {
          return { text: "", functionCalls: [{ name: "submit_review", args: { summary: "s", findings: [], missingTests: [], styleIssues: [] } }] };
        }
        return { text: "", functionCalls: [{ name: "read_changed_file", args: { path: "src/accounts.ts" } }] };
      },
    };
    const result = await new AgentOrchestrator(reg, { maxAgentIterations: 3, maxToolCalls: 10, maxToolsPerIteration: 4 }).run(session, "diff");
    expect(result.turns).toBe(3);
    expect(inputs.map((i) => i.forceFunction)).toEqual([undefined, undefined, "submit_review"]);
    // the turn before the final one carries a planning notice inside a real tool response
    const second = inputs[2];
    expect(second?.kind === "toolResults" && second.results.at(-1)?.response["notice"]).toMatch(/final/);
  });

  it("RequestBudget hard-stops at the configured number of API requests", () => {
    const budget = new RequestBudget(2);
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(/budget of 2/);
    expect(budget.used).toBe(2);
    const unlimited = new RequestBudget(undefined);
    for (let i = 0; i < 50; i++) unlimited.take();
    expect(unlimited.used).toBe(50);
  });

  it("scripted demo model drives all five tools end-to-end, and the guardrails reject its unsafe request", async () => {
    const logs: string[] = [];
    const agent = new ToolUsingReviewAgent(new ScriptedDemoModel(), git, DEFAULT_LIMITS, (m) => logs.push(m));
    const out = await new ReviewChangeUseCase(git, agent, DEFAULT_LIMITS).execute({ cwd: root });
    if (out.kind !== "reviewed") throw new Error("expected review");
    const { meta } = out.report;

    expect(new Set(meta.toolCalls.map((t) => t.name))).toEqual(
      new Set(["get_imports", "find_related_tests", "search_repository", "read_changed_file", "get_file_diff"]),
    );
    expect(meta.agentTurns).toBe(3);
    expect(meta.toolCalls.filter((t) => t.turn === 1)).toHaveLength(4); // parallel calls in one turn
    const unsafe = meta.toolCalls.find((t) => t.target.includes("passwd") || (!t.ok && t.name === "read_changed_file"));
    expect(unsafe?.ok).toBe(false);
    expect(unsafe?.summary).toMatch(/escapes the repository/);
    expect(out.report.findings).toEqual([]);
    expect(out.report.summary).toMatch(/SCRIPTED DEMO MODEL/);
    expect(out.report.coverage.skippedFiles.map((s) => s.path)).toContain(".env");
    expect(logs.some((l) => l.startsWith("[turn 1] model requested 4 tool call(s)"))).toBe(true);

    const text = renderText(out.report, root);
    expect(text).toContain("Agent trace: 3 model turn(s), 6 tool call(s)");
    expect(text).toContain("✗ read_changed_file");
    expect(text).not.toContain("changed-secret-value");
  });
});

describe("CLI arguments", () => {
  it("parses provider and max-calls", () => {
    expect(parseCliArgs(["review", "--provider", "mock", "--max-calls", "4"])).toMatchObject({ provider: "mock", maxCalls: 4 });
    expect(parseCliArgs(["review"])).toMatchObject({ provider: "gemini", format: "text" });
  });
  it.each([
    [["review", "--max-calls", "0"]],
    [["review", "--max-calls", "abc"]],
    [["review", "--provider", "openai"]],
    [["review", "--format", "yaml"]],
    [["deploy"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});

