/**
 * Builds a throwaway Git repository for the demo in .diff-sentinel/demo-repo
 *
 *   npm run demo:setup            base/ committed on main; change/ copied on top as UNCOMMITTED changes
 *   npm run demo:setup -- branch  base/ committed on main; change/ committed on branch feature/receipts as
 *                                 two commits (like a PR), with notify.ts left uncommitted
 */
import { execFileSync } from "node:child_process";
import { cp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const branchMode = process.argv.includes("branch");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples", "vulnerable-project");
const demo = path.join(root, ".diff-sentinel", "demo-repo");

const git = (...args: string[]) => execFileSync("git", args, { cwd: demo, stdio: "pipe", windowsHide: true });

await rm(demo, { recursive: true, force: true });
await cp(path.join(fixture, "base"), demo, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.name", "Demo");
git("config", "user.email", "demo@example.invalid");
git("config", "commit.gpgsign", "false");
git("config", "core.autocrlf", "false");
git("add", "-A");
git("commit", "-q", "-m", "baseline: safe transfer service");
await cp(path.join(fixture, "change"), demo, { recursive: true });

if (branchMode) {
  git("checkout", "-q", "-b", "feature/receipts");
  git("add", "src/accounts.ts");
  git("commit", "-q", "-m", "Add findAccountsByOwner lookup");
  git("add", "src/transfer.ts");
  git("commit", "-q", "-m", "Simplify transfer and send receipts");
  // src/notify.ts stays untracked: work in progress on top of the branch
}

// Decoy secret file (obviously fake) to demonstrate that sensitive files are excluded from the review.
// Generated here because the project's own .gitignore (rightly) ignores .env files.
await writeFile(path.join(demo, ".env"), "DB_PASSWORD=not-a-real-password-demo-only\n", "utf8");

const rel = path.relative(process.cwd(), demo) || ".";
console.log(`Demo repository ready (${branchMode ? "branch feature/receipts, PR-style" : "uncommitted changes"}): ${demo}`);
console.log("Try:");
console.log(`  npm run dev -- review --cwd ${rel} --provider mock${branchMode ? " --base main" : ""}      # free rehearsal`);
console.log(`  npm run dev -- review --cwd ${rel}${branchMode ? " --base main" : ""} --max-calls 3 --out ./.diff-sentinel/review.json`);
