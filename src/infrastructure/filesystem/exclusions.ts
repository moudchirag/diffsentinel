/**
 * Paths that are never read or sent to the model.
 * Returns a human-readable reason, or null when the path is allowed.
 * Input must be a repository-relative POSIX path.
 */
const EXCLUDED_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", ".diff-sentinel"]);

const LOCKFILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

export function exclusionReason(posixPath: string): string | null {
  const segments = posixPath.split("/");
  const base = (segments[segments.length - 1] ?? "").toLowerCase();

  for (const seg of segments.slice(0, -1)) {
    if (EXCLUDED_DIRS.has(seg.toLowerCase())) return `inside excluded directory "${seg}/"`;
  }
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) {
    return "environment file (may contain secrets)";
  }
  if (/\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/.test(base)) return "private key / certificate file";
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(base)) return "SSH key file";
  if (LOCKFILES.has(base)) return "lockfile";
  if (/\.min\.(js|css)$/.test(base) || base.endsWith(".map")) return "generated / minified file";
  return null;
}
