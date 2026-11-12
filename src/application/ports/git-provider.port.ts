export type ChangedFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export interface ChangedFile {
  /** Repository-relative POSIX-style path. */
  path: string;
  status: ChangedFileStatus;
  /** Previous path for renames/copies. */
  oldPath?: string;
  /** Only known for tracked files (from git numstat); untracked binaries are detected on read. */
  isBinary?: boolean;
}

/**
 * What the working tree is compared against.
 *  - "working-tree": uncommitted changes vs HEAD (default)
 *  - "branch": everything since the branch diverged from `ref` (merge-base), i.e. its commits + uncommitted work.
 *    This is the same comparison a pull request shows.
 */
export interface DiffBase {
  mode: "working-tree" | "branch";
  /** What the user asked for: "HEAD" or e.g. "main" / "origin/main". */
  ref: string;
  /** The commit actually diffed against (HEAD, the merge-base, or the empty tree before the first commit). */
  commit: string;
}

export interface DiffSnapshot {
  repositoryRoot: string;
  base: DiffBase;
  /** Current branch name, or null when detached / no commits yet. */
  branch: string | null;
  /** Subjects of the commits being reviewed (branch mode only), newest first. */
  commits: string[];
  changedFiles: ChangedFile[];
}

export interface GitProvider {
  getRepositoryRoot(cwd: string): Promise<string>;
  /**
   * Manifest of tracked changes (staged + unstaged, plus branch commits when `baseRef` is given)
   * and untracked non-ignored files.
   */
  collectWorkingTreeDiff(cwd: string, options?: { baseRef?: string }): Promise<DiffSnapshot>;
  /** Unified diff of one tracked changed file: working tree vs `baseCommit`. */
  getFileDiff(repositoryRoot: string, baseCommit: string, file: ChangedFile): Promise<string>;
  /** Tracked + untracked non-ignored files, repo-relative POSIX paths. */
  listFiles(repositoryRoot: string): Promise<string[]>;
}
