import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

/** Creates an empty temp directory initialised as a Git repo (local identity, no signing). */
export async function createTempRepo(prefix = "ds-repo-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "DiffSentinel Test");
  git(dir, "config", "user.email", "test@example.invalid");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

export async function writeRepoFile(root: string, rel: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

export function commitAll(root: string, message = "baseline"): void {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export { cp };
