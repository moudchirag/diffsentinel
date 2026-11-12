import path from "node:path";
import { exclusionReason } from "./exclusions.js";

const TEST_SUFFIX = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIRS = new Set(["__tests__", "tests", "test", "spec", "specs"]);

function stemOf(file: string): string {
  const base = path.posix.basename(file);
  const noExt = base.replace(/\.(test|spec)(?=\.)/i, "").replace(/\.[^.]+$/, "");
  // Only strip test-ish affixes from files that are actually tests (so "latest.ts" stays "latest").
  if (!isTestFile(file)) return noExt.toLowerCase();
  // "user_service_test", "user-service-spec", "UserServiceTests" -> strip the affix; "latest" is left alone.
  return noExt
    .replace(/^test_/i, "")
    .replace(/[_-](?:test|spec)s?$/i, "")
    .replace(/(?<=[a-z0-9])(?:Tests?|Specs?)$/, "")
    .toLowerCase();
}

export function isTestFile(file: string): boolean {
  const posix = file.replaceAll("\\", "/");
  const base = path.posix.basename(posix);
  const dirs = posix.split("/").slice(0, -1).map((d) => d.toLowerCase());
  return (
    TEST_SUFFIX.test(base) ||
    /^test_.+\.py$/i.test(base) ||
    /_test\.(py|go|rb)$/i.test(base) ||
    /tests?\.cs$/i.test(base) ||
    dirs.some((d) => TEST_DIRS.has(d))
  );
}

/**
 * Deterministic, name-based discovery of likely tests for a changed file.
 * Pure function over a list of repository paths; never touches the filesystem.
 */
export function findRelatedTests(changedFile: string, repoFiles: readonly string[], limit: number): string[] {
  const target = stemOf(changedFile);
  if (!target || isTestFile(changedFile)) return [];
  return repoFiles
    .filter((f) => f !== changedFile && !exclusionReason(f) && isTestFile(f) && stemOf(f) === target)
    .sort()
    .slice(0, limit);
}
