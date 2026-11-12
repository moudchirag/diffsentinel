// Launches Vitest with an uppercase Windows drive letter.
// If the shell's cwd is "z:\..." (lowercase), Vitest loads two copies of itself and every test file fails with
// "Vitest failed to find the runner". Normalising the drive letter before launching avoids that.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/^[a-z]:/, (d) => d.toUpperCase());
const bin = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
