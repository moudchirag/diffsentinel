/**
 * Best-effort secret redaction. NOT a guarantee: never rely on this alone.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/AIza[0-9A-Za-z_-]{35}/g, "[REDACTED GOOGLE API KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY ID]"],
  [/\bgh[pousr]_[0-9A-Za-z]{30,}\b/g, "[REDACTED GITHUB TOKEN]"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED API KEY]"],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi, "$1[REDACTED]$3"],
];

export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, (match: string) => {
      redactions++;
      return match.replace(new RegExp(re.source, re.flags.replace("g", "")), replacement);
    });
  }
  return { text: out, redactions };
}
