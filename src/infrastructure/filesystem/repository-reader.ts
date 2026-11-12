import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { UnsafePathError } from "../../domain/review-errors.js";
import { exclusionReason } from "./exclusions.js";
import { redactSecrets } from "./redact.js";

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  bytesRead: number;
  totalBytes: number;
  redactions: number;
}

/**
 * Safe, read-only access to files inside one repository root.
 * Every read: validates the path, checks the caller-supplied allowlist,
 * applies exclusions, resolves symlinks, enforces the root boundary and size limit.
 */
export class RepositoryReader {
  private constructor(
    private readonly realRoot: string,
    private readonly maxFileBytes: number,
  ) {}

  static async create(repositoryRoot: string, maxFileBytes: number): Promise<RepositoryReader> {
    return new RepositoryReader(await realpath(repositoryRoot), maxFileBytes);
  }

  /** Normalizes a model/user supplied path to a safe repo-relative POSIX path or throws. */
  static normalize(input: string): string {
    if (typeof input !== "string" || input.length === 0) throw new UnsafePathError("Path must be a non-empty string.");
    if (input.includes("\0")) throw new UnsafePathError("Path contains a NUL byte.");
    const slashed = input.replaceAll("\\", "/");
    if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed)) throw new UnsafePathError("Absolute paths are not allowed.");
    const normalized = path.posix.normalize(slashed);
    if (normalized === ".." || normalized.startsWith("../") || normalized === ".") {
      throw new UnsafePathError("Path escapes the repository.");
    }
    return normalized;
  }

  async read(inputPath: string, allowed: ReadonlySet<string>, maxBytes = this.maxFileBytes): Promise<FileContent> {
    const rel = RepositoryReader.normalize(inputPath);
    if (!allowed.has(rel)) throw new UnsafePathError(`"${rel}" is not an allowed file for this tool.`);
    const excluded = exclusionReason(rel);
    if (excluded) throw new UnsafePathError(`"${rel}" is excluded: ${excluded}.`);

    const absolute = path.resolve(this.realRoot, rel);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw new UnsafePathError(`"${rel}" does not exist on disk.`);
    }
    const relToRoot = path.relative(this.realRoot, real);
    if (relToRoot === "" || relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new UnsafePathError(`"${rel}" resolves outside the repository (symlink?).`);
    }
    // Re-check exclusions on the resolved target so a symlink cannot alias an excluded file.
    const resolvedExcluded = exclusionReason(relToRoot.split(path.sep).join("/"));
    if (resolvedExcluded) throw new UnsafePathError(`"${rel}" resolves to an excluded file: ${resolvedExcluded}.`);

    const stat = await lstat(real);
    if (!stat.isFile()) throw new UnsafePathError(`"${rel}" is not a regular file.`);

    const handle = await open(real, "r");
    try {
      const toRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(toRead);
      const { bytesRead } = await handle.read(buffer, 0, toRead, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (slice.includes(0)) throw new UnsafePathError(`"${rel}" appears to be a binary file.`);
      const { text, redactions } = redactSecrets(slice.toString("utf8"));
      return {
        path: rel,
        content: text,
        truncated: stat.size > bytesRead,
        bytesRead,
        totalBytes: stat.size,
        redactions,
      };
    } finally {
      await handle.close();
    }
  }
}
