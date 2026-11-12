import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient, SessionInput } from "../../src/agent/model-session.js";
import { ToolUsingReviewAgent } from "../../src/agent/review-agent.js";
import { ContextBuilder } from "../../src/application/context-builder.js";
import { ReviewChangeUseCase } from "../../src/application/review-change.usecase.js";
import { parseCliArgs, UsageError } from "../../src/cli/parse-args.js";
import { DEFAULT_LIMITS } from "../../src/config/limits.js";
import { GitCommandError } from "../../src/domain/review-errors.js";
import { RepositoryReader } from "../../src/infrastructure/filesystem/repository-reader.js";
import { GitCliProvider } from "../../src/infrastructure/git/git-cli.provider.js";
import { commitAll, createTempRepo, git, removeDir, writeRepoFile } from "../helpers/temp-repo.js";

const provider = new GitCliProvider();
let root: string;

/**
 * main:     base.ts, legacy.ts, shared.ts
 * feature:  commit 1 adds feature.ts; commit 2 edits base.ts and deletes legacy.ts
 *           + uncommitted edit to feature.ts + untracked notes.ts
 * main (later, after the branch point): adds main-only.ts and edits shared.ts  -> must NOT appear in the review
 */
beforeEach(async () => {
  root = await createTempRepo();
  await writeRepoFile(root, "base.ts", "export const base = 1;\n");
  await writeRepoFile(root, "legacy.ts", "export const legacy = 1;\n");
  await writeRepoFile(root, "shared.ts", "export const shared = 1;\n");
  commitAll(root, "initial");

  git(root, "checkout", "-q", "-b", "feature/payments");
  await writeRepoFile(root, "feature.ts", "export const feature = 1;\n");
  commitAll(root, "Add feature module");
  await writeRepoFile(root, "base.ts", "export const base = 2;\n");
  await rm(path.join(root, "legacy.ts"));
  commitAll(root, "Bump base and drop legacy");

  git(root, "checkout", "-q", "main");
  await writeRepoFile(root, "main-only.ts", "export const mainOnly = 1;\n");
  await writeRepoFile(root, "shared.ts", "export const shared = 99;\n");
  commitAll(root, "Work that landed on main later");

  git(root, "checkout", "-q", "feature/payments");
  await writeRepoFile(root, "feature.ts", "export const feature = 2; // uncommitted\n");
  await writeRepoFile(root, "notes.ts", "export const notes = 1;\n");
});
afterEach(async () => {
  await removeDir(root);
});

const paths = (files: Array<{ path: string; status: string }>) => files.map((f) => `${f.status}:${f.path}`).sort();

describe("branch / PR review (--base)", () => {
  it("default mode reviews only uncommitted work", async () => {
    const snap = await provider.collectWorkingTreeDiff(root);
    expect(snap.base.mode).toBe("working-tree");
    expect(snap.branch).toBe("feature/payments");
    expect(paths(snap.changedFiles)).toEqual(["modified:feature.ts", "untracked:notes.ts"]);
    expect(snap.commits).toEqual([]);
  });

  it("--base main reviews all branch commits + uncommitted work, measured from the merge-base", async () => {
    const snap = await provider.collectWorkingTreeDiff(root, { baseRef: "main" });
    expect(snap.base.mode).toBe("branch");
    expect(snap.base.ref).toBe("main");
    expect(snap.base.commit).toBe(git(root, "merge-base", "main", "HEAD").trim());
    // feature.ts is "added" relative to the merge-base (committed on the branch, then edited again uncommitted)
    expect(paths(snap.changedFiles)).toEqual(["added:feature.ts", "deleted:legacy.ts", "modified:base.ts", "untracked:notes.ts"]);
    // work that landed on main after the branch point is NOT attributed to this branch
    expect(snap.changedFiles.map((f) => f.path)).not.toContain("main-only.ts");
    expect(snap.changedFiles.map((f) => f.path)).not.toContain("shared.ts");
    expect(snap.commits).toEqual(["Bump base and drop legacy", "Add feature module"]);

    const diff = await provider.getFileDiff(root, snap.base.commit, snap.changedFiles.find((f) => f.path === "feature.ts")!);
    expect(diff).toContain("+export const feature = 2; // uncommitted");
  });

  it("puts scope, branch, commit messages and intent into the model context as untrusted work context", async () => {
    const snap = await provider.collectWorkingTreeDiff(root, { baseRef: "main" });
    const reader = await RepositoryReader.create(snap.repositoryRoot, DEFAULT_LIMITS.maxFileBytes);
    const ctx = await new ContextBuilder(provider, reader, DEFAULT_LIMITS).build(snap, {
      intent: "Prepare payments feature; legacy.ts is intentionally removed",
    });
    expect(ctx.userMessage).toContain("<untrusted_work_context>");
    expect(ctx.userMessage).toMatch(/branch "feature\/payments" vs main \(merge-base [0-9a-f]{7}\): 2 commit\(s\)/);
    expect(ctx.userMessage).toContain("- Bump base and drop legacy");
    expect(ctx.userMessage).toContain("Developer-stated intent: Prepare payments feature");
    expect(ctx.userMessage).toContain("-export const legacy = 1;");
    expect(ctx.base.mode).toBe("branch");
  });

  it("the agent's get_file_diff tool uses the same branch base", async () => {
    const seen: SessionInput[] = [];
    const model: ModelClient = {
      modelName: "fake",
      startSession: () => {
        let turn = 0;
        return {
          async send(input) {
            seen.push(input);
            turn++;
            if (turn === 1) return { text: "", functionCalls: [{ name: "get_file_diff", args: { path: "base.ts" } }] };
            return { text: "", functionCalls: [{ name: "submit_review", args: { summary: "s", findings: [], missingTests: [], styleIssues: [] } }] };
          },
        };
      },
    };
    const agent = new ToolUsingReviewAgent(model, provider, DEFAULT_LIMITS);
    const out = await new ReviewChangeUseCase(provider, agent, DEFAULT_LIMITS).execute({ cwd: root, baseRef: "main" });
    if (out.kind !== "reviewed") throw new Error("expected review");
    const toolInput = seen[1];
    if (toolInput?.kind !== "toolResults") throw new Error("expected tool results");
    expect(JSON.stringify(toolInput.results[0]?.response)).toContain("+export const base = 2;");
    expect(out.report.meta.scope).toMatchObject({ mode: "branch", base: "main", branch: "feature/payments", commitCount: 2 });
  });

  it("rejects unknown refs and option-like refs with a clear error", async () => {
    await expect(provider.collectWorkingTreeDiff(root, { baseRef: "does-not-exist" })).rejects.toThrow(/Unknown --base ref/);
    await expect(provider.collectWorkingTreeDiff(root, { baseRef: "--output=/tmp/x" })).rejects.toBeInstanceOf(GitCommandError);
    await expect(provider.collectWorkingTreeDiff(root, { baseRef: "main; rm -rf /" })).rejects.toThrow(/Invalid --base ref/);
  });

  it("reports no changes when the branch has nothing beyond the base", async () => {
    git(root, "stash", "-u", "-q");
    git(root, "checkout", "-q", "main");
    const agent = { review: () => Promise.reject(new Error("must not be called")) };
    const out = await new ReviewChangeUseCase(provider, agent, DEFAULT_LIMITS).execute({ cwd: root, baseRef: "main" });
    expect(out.kind).toBe("no-changes");
  });

  it("CLI accepts --base and --intent and validates them", () => {
    expect(parseCliArgs(["review", "--base", "origin/main", "--intent", "fix rounding"])).toMatchObject({
      base: "origin/main",
      intent: "fix rounding",
    });
    expect(() => parseCliArgs(["review", "--intent", "x".repeat(501)])).toThrow(UsageError);
    expect(() => parseCliArgs(["review", "--base", " "])).toThrow(UsageError);
  });
});
