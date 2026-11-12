import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolUsingReviewAgent } from "../../src/agent/review-agent.js";
import type { ModelClient, ModelSession, SessionInput } from "../../src/agent/model-session.js";
import type { ReviewAgent } from "../../src/application/ports/review-agent.port.js";
import { ReviewChangeUseCase } from "../../src/application/review-change.usecase.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { DEFAULT_LIMITS } from "../../src/config/limits.js";
import { NotAGitRepositoryError } from "../../src/domain/review-errors.js";
import type { ReviewFinding } from "../../src/domain/review-finding.js";
import { GitCliProvider } from "../../src/infrastructure/git/git-cli.provider.js";
import { RepositoryReader } from "../../src/infrastructure/filesystem/repository-reader.js";
import { commitAll, createTempRepo, git, removeDir, writeRepoFile } from "../helpers/temp-repo.js";

const gitProvider = new GitCliProvider();
let root: string;

beforeEach(async () => {
  root = await createTempRepo();
});
afterEach(async () => {
  await removeDir(root);
});

const byPath = <T extends { path: string }>(files: T[], p: string): T | undefined => files.find((f) => f.path === p);

describe("GitCliProvider", () => {
  it("collects staged, unstaged, untracked, deleted, renamed and binary changes", async () => {
    await writeRepoFile(root, "keep.ts", "export const keep = 1;\n");
    await writeRepoFile(root, "staged.ts", "export const s = 1;\n");
    await writeRepoFile(root, "gone.ts", "export const gone = 1;\n");
    await writeRepoFile(root, "old name.ts", "export const renamedFile = 'a long enough body to be detected as a rename';\n".repeat(5));
    await writeRepoFile(root, "pic.png", Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]));
    await writeRepoFile(root, ".gitignore", "ignored.log\n");
    commitAll(root);

    await writeRepoFile(root, "keep.ts", "export const keep = 2;\n"); // unstaged edit
    await writeRepoFile(root, "staged.ts", "export const s = 2;\n");
    git(root, "add", "staged.ts"); // staged edit
    await rm(path.join(root, "gone.ts")); // deleted
    git(root, "mv", "old name.ts", "new name.ts"); // renamed (staged)
    await writeRepoFile(root, "pic.png", Buffer.from([137, 80, 78, 71, 0, 9, 9, 9])); // binary modified
    await writeRepoFile(root, "brand new.ts", "export const n = 1;\n"); // untracked
    await writeRepoFile(root, "ignored.log", "noise"); // ignored -> must not appear

    const snap = await gitProvider.collectWorkingTreeDiff(root);
    const files = snap.changedFiles;
    expect(byPath(files, "keep.ts")?.status).toBe("modified");
    expect(byPath(files, "staged.ts")?.status).toBe("modified");
    expect(byPath(files, "gone.ts")?.status).toBe("deleted");
    expect(byPath(files, "new name.ts")).toMatchObject({ status: "renamed", oldPath: "old name.ts" });
    expect(byPath(files, "pic.png")?.isBinary).toBe(true);
    expect(byPath(files, "brand new.ts")?.status).toBe("untracked");
    expect(byPath(files, "ignored.log")).toBeUndefined();
    expect(byPath(files, "old name.ts")).toBeUndefined();

    // staged + unstaged both visible in the per-file diff against HEAD
    expect(await gitProvider.getFileDiff(snap.repositoryRoot, snap.base.commit, byPath(files, "keep.ts")!)).toContain("+export const keep = 2;");
    expect(await gitProvider.getFileDiff(snap.repositoryRoot, snap.base.commit, byPath(files, "staged.ts")!)).toContain("+export const s = 2;");
    expect(await gitProvider.getFileDiff(snap.repositoryRoot, snap.base.commit, byPath(files, "gone.ts")!)).toContain("-export const gone = 1;");
    expect(await gitProvider.getFileDiff(snap.repositoryRoot, snap.base.commit, byPath(files, "brand new.ts")!)).toBe("");
  });

  it("works in a repository with no commits yet", async () => {
    await writeRepoFile(root, "a.ts", "export const a = 1;\n");
    git(root, "add", "a.ts");
    await writeRepoFile(root, "b.ts", "export const b = 1;\n");
    const snap = await gitProvider.collectWorkingTreeDiff(root);
    expect(byPath(snap.changedFiles, "a.ts")?.status).toBe("added");
    expect(byPath(snap.changedFiles, "b.ts")?.status).toBe("untracked");
  });

  it("returns an empty manifest for a clean tree", async () => {
    await writeRepoFile(root, "a.ts", "x\n");
    commitAll(root);
    expect((await gitProvider.collectWorkingTreeDiff(root)).changedFiles).toEqual([]);
  });

  it("throws NotAGitRepositoryError outside a repository", async () => {
    const outside = path.join(os.tmpdir(), `ds-not-a-repo-${Date.now()}`);
    await import("node:fs/promises").then((fs) => fs.mkdir(outside, { recursive: true }));
    // The temp dir can live inside a parent repo (e.g. a home directory that is itself a Git repo); fence it off.
    const previous = process.env["GIT_CEILING_DIRECTORIES"];
    process.env["GIT_CEILING_DIRECTORIES"] = os.tmpdir();
    try {
      await expect(gitProvider.getRepositoryRoot(outside)).rejects.toBeInstanceOf(NotAGitRepositoryError);
    } finally {
      if (previous === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
      else process.env["GIT_CEILING_DIRECTORIES"] = previous;
      await removeDir(outside);
    }
  });

  it("lists tracked and untracked files but not ignored ones", async () => {
    await writeRepoFile(root, ".gitignore", "out/\n");
    await writeRepoFile(root, "src/a.ts", "x\n");
    commitAll(root);
    await writeRepoFile(root, "src/b.ts", "y\n");
    await writeRepoFile(root, "out/c.ts", "z\n");
    const files = await gitProvider.listFiles(root);
    expect(files).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    expect(files).not.toContain("out/c.ts");
  });
});

describe("ContextBuilder", () => {
  async function build(limits = DEFAULT_LIMITS) {
    const snap = await gitProvider.collectWorkingTreeDiff(root);
    const reader = await RepositoryReader.create(snap.repositoryRoot, limits.maxFileBytes);
    return new ContextBuilder(gitProvider, reader, limits).build(snap);
  }

  it("excludes secrets/binaries/lockfiles, previews untracked files, and marks them as skipped", async () => {
    await writeRepoFile(root, "a.ts", "export const a = 1;\n");
    commitAll(root);
    await writeRepoFile(root, "a.ts", "export const a = 2;\n");
    await writeRepoFile(root, ".env", "KEY=value-that-must-not-leak\n");
    await writeRepoFile(root, "package-lock.json", "{}\n");
    await writeRepoFile(root, "new.ts", "export const n = 1;\n");

    const ctx = await build();
    expect(ctx.userMessage).toContain("+export const a = 2;");
    expect(ctx.userMessage).toContain("NEW UNTRACKED FILE");
    expect(ctx.userMessage).not.toContain("value-that-must-not-leak");
    expect(ctx.coverage.skippedFiles.map((s) => s.path).sort()).toEqual([".env", "package-lock.json"]);
    expect(ctx.coverage.reviewedFiles.sort()).toEqual(["a.ts", "new.ts"]);
    expect(ctx.coverage.isPartial).toBe(false); // exclusions are reported but are not a size-limit gap
    expect(ctx.coverage.warnings.join(" ")).toMatch(/excluded/);
    expect(ctx.readableFiles.has(".env")).toBe(false);
  });

  it("represents deleted files by their diff and does not make them readable", async () => {
    await writeRepoFile(root, "gone.ts", "export const gone = 1;\n");
    commitAll(root);
    await rm(path.join(root, "gone.ts"));
    const ctx = await build();
    expect(ctx.userMessage).toContain("-export const gone = 1;");
    expect(ctx.readableFiles.has("gone.ts")).toBe(false);
  });

  it("redacts secret-looking values inside diffs", async () => {
    await writeRepoFile(root, "cfg.ts", "export const x = 1;\n");
    commitAll(root);
    await writeRepoFile(root, "cfg.ts", 'export const apiKey = "abcdefgh12345678";\n');
    const ctx = await build();
    expect(ctx.userMessage).not.toContain("abcdefgh12345678");
    expect(ctx.coverage.warnings.join(" ")).toMatch(/redacted/);
  });

  it("enforces the file-count and diff-size budgets and marks the review partial", async () => {
    for (let i = 0; i < 5; i++) await writeRepoFile(root, `f${i}.ts`, `export const v${i} = ${i};\n`);
    commitAll(root);
    for (let i = 0; i < 5; i++) await writeRepoFile(root, `f${i}.ts`, `export const v${i} = ${i + 100};\n`);

    const ctx = await build({ ...DEFAULT_LIMITS, maxChangedFiles: 3 });
    expect(ctx.coverage.reviewedFiles).toHaveLength(3);
    expect(ctx.coverage.skippedFiles).toHaveLength(2);
    expect(ctx.coverage.isPartial).toBe(true);
    expect(ctx.userMessage).toContain("PARTIAL");
    // files skipped for limits remain readable through the tool
    expect(ctx.readableFiles.size).toBe(5);

    const tiny = await build({ ...DEFAULT_LIMITS, maxDiffCharacters: 700, maxContextCharacters: 700 });
    expect(tiny.coverage.isPartial).toBe(true);
    expect(tiny.userMessage.length).toBeLessThan(3500);
  });

  it("truncates oversized untracked files and says so", async () => {
    await writeRepoFile(root, "a.ts", "x\n");
    commitAll(root);
    await writeRepoFile(root, "huge.ts", "export const line = 1;\n".repeat(2000));
    const ctx = await build({ ...DEFAULT_LIMITS, maxFileBytes: 1000 });
    expect(ctx.coverage.isPartial).toBe(true);
    expect(ctx.userMessage).toContain("truncated");
  });
});

describe("ReviewChangeUseCase", () => {
  const emptyReview = { summary: "ok", findings: [], missingTests: [], styleIssues: [] };

  it("returns no-changes without calling the agent", async () => {
    await writeRepoFile(root, "a.ts", "x\n");
    commitAll(root);
    const agent: ReviewAgent = { review: vi.fn() };
    const out = await new ReviewChangeUseCase(gitProvider, agent, DEFAULT_LIMITS).execute({ cwd: root });
    expect(out.kind).toBe("no-changes");
    expect(agent.review).not.toHaveBeenCalled();
  });

  it("assembles a report: deterministic risk, coverage, warnings for unmatched evidence and foreign files", async () => {
    await writeRepoFile(root, "a.ts", "export const a = 1;\n");
    commitAll(root);
    await writeRepoFile(root, "a.ts", "export const a = 2;\n");

    const finding = (over: object): ReviewFinding => ({
      id: "F1", category: "bug", severity: "medium", title: "t", file: "a.ts", lineStart: null, lineEnd: null,
      description: "d", evidence: "export const a = 2;", recommendation: "r", confidence: 0.5, ...over,
    });
    const agent: ReviewAgent = {
      review: async () => ({
        model: "fake-model",
        turns: 1,
        toolCalls: [],
        review: {
          ...emptyReview,
          findings: [
            finding({ severity: "low", id: "F1" }),
            finding({ severity: "critical", id: "F1", title: "dup id + invented evidence", evidence: "this text is not in the diff" }),
            finding({ id: "F3", file: "not-changed.ts", title: "foreign file" }),
          ],
        },
      }),
    };
    const out = await new ReviewChangeUseCase(gitProvider, agent, DEFAULT_LIMITS).execute({ cwd: root });
    if (out.kind !== "reviewed") throw new Error("expected review");
    const r = out.report;
    expect(r.schemaVersion).toBe(1);
    expect(r.overallRisk).toBe("critical");
    expect(r.findings[0]?.severity).toBe("critical"); // sorted most severe first
    expect(new Set(r.findings.map((f) => f.id)).size).toBe(3); // duplicate ids disambiguated
    expect(r.coverage.reviewedFiles).toEqual(["a.ts"]);
    const w = r.coverage.warnings.join("\n");
    expect(w).toMatch(/could not be matched verbatim/);
    expect(w).toMatch(/not part of the change set/);
    expect(w).toMatch(/without requesting additional context/);
    expect(r.meta.model).toBe("fake-model");
  });

  it("end-to-end with a fake model: tool is requested, executed locally and its result reaches the model", async () => {
    await writeRepoFile(root, "src/users.ts", "export function find(id: string) { return id; }\n");
    await writeRepoFile(root, "tests/users.test.ts", "import { find } from '../src/users';\ntest('find', () => {});\n");
    commitAll(root);
    await writeRepoFile(root, "src/users.ts", "export function find(id: string) { return `SELECT * FROM u WHERE id='${id}'`; }\n");

    const seen: SessionInput[] = [];
    const model: ModelClient = {
      modelName: "fake",
      startSession: () => {
        let turn = 0;
        const session: ModelSession = {
          async send(input) {
            seen.push(input);
            turn++;
            if (turn === 1) {
              return { text: "", functionCalls: [
                { id: "1", name: "read_changed_file", args: { path: "src/users.ts" } },
                { id: "2", name: "find_related_tests", args: { changedFile: "src/users.ts" } },
              ] };
            }
            return { text: "", functionCalls: [{ name: "submit_review", args: {
              summary: "SQL built by interpolation.",
              findings: [{ id: "F1", category: "security", severity: "critical", title: "Possible SQL injection", file: "src/users.ts",
                lineStart: 1, lineEnd: 1, description: "d", evidence: "WHERE id='${id}'", recommendation: "parameterize", confidence: 0.9 }],
              missingTests: [{ description: "test hostile ids", priority: "high", relatedFile: "src/users.ts" }],
              styleIssues: [],
            } }] };
          },
        };
        return session;
      },
    };
    const agent = new ToolUsingReviewAgent(model, gitProvider, DEFAULT_LIMITS);
    const out = await new ReviewChangeUseCase(gitProvider, agent, DEFAULT_LIMITS).execute({ cwd: root });
    if (out.kind !== "reviewed") throw new Error("expected review");

    expect(out.report.meta.toolCalls).toMatchObject([
      { turn: 1, name: "read_changed_file", ok: true, target: "src/users.ts" },
      { turn: 1, name: "find_related_tests", ok: true, target: "src/users.ts", summary: "1 related test file(s)" },
    ]);
    expect(out.report.meta.agentTurns).toBe(2);
    const toolInput = seen[1];
    if (toolInput?.kind !== "toolResults") throw new Error("expected tool results");
    expect(JSON.stringify(toolInput.results[0]?.response)).toContain("SELECT * FROM u");
    expect(JSON.stringify(toolInput.results[1]?.response)).toContain("tests/users.test.ts");
    expect(out.report.overallRisk).toBe("critical");
    expect(out.report.coverage.warnings.join(" ")).not.toMatch(/could not be matched/); // evidence verified via tool output/diff
  });
});

