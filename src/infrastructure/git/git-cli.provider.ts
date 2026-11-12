import { execFile } from "node:child_process";
import type {
  ChangedFile,
  ChangedFileStatus,
  DiffBase,
  DiffSnapshot,
  GitProvider,
} from "../../application/ports/git-provider.port.js";
import { GitCommandError, NotAGitRepositoryError } from "../../domain/review-errors.js";

/** Git's well-known empty tree object; used as the base when the repo has no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_BUFFER = 64 * 1024 * 1024;

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed, application-owned arguments only. shell:false so nothing is interpreted by a shell.
    execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, shell: false, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return reject(new GitCommandError("Git executable not found. Install Git and make sure it is on your PATH."));
        }
        if (/not a git repository/i.test(stderr)) {
          return reject(new NotAGitRepositoryError(`"${cwd}" is not inside a Git repository. Run from a repository or pass --cwd.`));
        }
        reject(new GitCommandError(`git ${args[0] ?? ""} failed: ${stderr.trim() || error.message}`, { cause: error }));
      },
    );
  });
}

function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

const toPosix = (p: string): string => p.replaceAll("\\", "/");

function mapStatus(letter: string): ChangedFileStatus {
  switch (letter[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified"; // M, T (type change), U, etc.
  }
}

/** Parses `git diff --name-status -M -z` output. */
export function parseNameStatus(output: string): ChangedFile[] {
  const tokens = splitNul(output);
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++] ?? "";
    const kind = mapStatus(status);
    if (kind === "renamed" || kind === "copied") {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath !== undefined && newPath !== undefined) {
        files.push({ path: toPosix(newPath), oldPath: toPosix(oldPath), status: kind });
      }
    } else {
      const p = tokens[i++];
      if (p !== undefined) files.push({ path: toPosix(p), status: kind });
    }
  }
  return files;
}

/** Parses `git diff --numstat -M -z` output and returns the set of binary paths (shown as "-\t-"). */
export function parseBinaryPaths(output: string): Set<string> {
  const tokens = splitNul(output);
  const binary = new Set<string>();
  for (let i = 0; i < tokens.length; ) {
    const entry = tokens[i++] ?? "";
    const m = /^(\S+)\t(\S+)\t(.*)$/.exec(entry);
    if (!m) continue;
    const isBinary = m[1] === "-" && m[2] === "-";
    let p = m[3] ?? "";
    if (p === "") {
      // rename/copy: following two tokens are old and new path
      i++; // old path
      p = tokens[i++] ?? "";
    }
    if (isBinary && p) binary.add(toPosix(p));
  }
  return binary;
}

export class GitCliProvider implements GitProvider {
  async getRepositoryRoot(cwd: string): Promise<string> {
    const out = await runGit(["rev-parse", "--show-toplevel"], cwd);
    return out.trim();
  }

  private async headCommit(root: string): Promise<string | null> {
    try {
      return (await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], root)).trim();
    } catch {
      return null; // unborn HEAD: nothing committed yet
    }
  }

  private async currentBranch(root: string): Promise<string | null> {
    try {
      const name = (await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], root)).trim();
      return name || null;
    } catch {
      return null; // detached HEAD
    }
  }

  /** Resolves what to diff against. For branch mode: the merge-base of `baseRef` and HEAD (what a PR shows). */
  private async resolveBase(root: string, baseRef: string | undefined): Promise<DiffBase> {
    const head = await this.headCommit(root);
    if (baseRef === undefined) return { mode: "working-tree", ref: "HEAD", commit: head ?? EMPTY_TREE };

    // The ref is user input: refuse anything that could be parsed as an option, and end option parsing explicitly.
    if (!/^[\w./@^~{}-]{1,200}$/.test(baseRef) || baseRef.startsWith("-")) {
      throw new GitCommandError(`Invalid --base ref "${baseRef.slice(0, 50)}".`);
    }
    if (!head) throw new GitCommandError("--base needs at least one commit on the current branch.");
    let target: string;
    try {
      target = (await runGit(["rev-parse", "--verify", "--quiet", "--end-of-options", `${baseRef}^{commit}`], root)).trim();
    } catch {
      throw new GitCommandError(`Unknown --base ref "${baseRef}". Try a branch such as main or origin/main (run git fetch first).`);
    }
    let mergeBase: string;
    try {
      mergeBase = (await runGit(["merge-base", target, head], root)).trim();
    } catch {
      throw new GitCommandError(`"${baseRef}" and the current branch have no common history.`);
    }
    return { mode: "branch", ref: baseRef, commit: mergeBase };
  }

  async collectWorkingTreeDiff(cwd: string, options: { baseRef?: string } = {}): Promise<DiffSnapshot> {
    const repositoryRoot = await this.getRepositoryRoot(cwd);
    const base = await this.resolveBase(repositoryRoot, options.baseRef);
    const branch = await this.currentBranch(repositoryRoot);

    const [nameStatus, numstat, untracked, log] = await Promise.all([
      runGit(["diff", "--no-ext-diff", "--name-status", "-M", "-z", base.commit, "--"], repositoryRoot),
      runGit(["diff", "--no-ext-diff", "--numstat", "-M", "-z", base.commit, "--"], repositoryRoot),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], repositoryRoot),
      base.mode === "branch"
        ? runGit(["log", "--no-color", "--format=%s", "-n", "30", `${base.commit}..HEAD`, "--"], repositoryRoot)
        : Promise.resolve(""),
    ]);
    const commits = log.split("\n").map((s) => s.trim()).filter(Boolean);

    const binaryPaths = parseBinaryPaths(numstat);
    const tracked = parseNameStatus(nameStatus).map((f) => (binaryPaths.has(f.path) ? { ...f, isBinary: true } : f));
    const trackedPaths = new Set(tracked.map((f) => f.path));
    const untrackedFiles: ChangedFile[] = splitNul(untracked)
      .map(toPosix)
      .filter((p) => !trackedPaths.has(p))
      .map((p) => ({ path: p, status: "untracked" as const }));

    const changedFiles = [...tracked, ...untrackedFiles].sort((a, b) => a.path.localeCompare(b.path));
    return { repositoryRoot, base, branch, commits, changedFiles };
  }

  async getFileDiff(repositoryRoot: string, baseCommit: string, file: ChangedFile): Promise<string> {
    if (file.status === "untracked") return "";
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
    return runGit(["diff", "--no-ext-diff", "--unified=5", "-M", baseCommit, "--", ...paths], repositoryRoot);
  }

  async listFiles(repositoryRoot: string): Promise<string[]> {
    const out = await runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], repositoryRoot);
    return Array.from(new Set(splitNul(out).map(toPosix)));
  }
}
