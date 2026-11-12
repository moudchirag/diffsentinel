/**
 * Lists Gemini models available to the configured key that support generateContent.
 * Uses the models.list metadata endpoint (no content generation). Never prints the key.
 *   npx tsx scripts/list-models.ts
 */
import { config } from "dotenv";
import { GoogleGenAI } from "@google/genai";

config({ quiet: true });
const apiKey = process.env["GEMINI_API_KEY"];
if (!apiKey || apiKey === "replace_me") {
  console.error("GEMINI_API_KEY is not set (.env).");
  process.exit(1);
}
// Same API version as the review client (function calling needs v1beta).
const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
const pager = await ai.models.list({ config: { pageSize: 100 } });
const rows: string[] = [];
for await (const m of pager) {
  if (!m.supportedActions?.includes("generateContent")) continue;
  rows.push(`${(m.name ?? "").replace(/^models\//, "").padEnd(45)} in:${m.inputTokenLimit ?? "?"}  ${m.displayName ?? ""}`);
}
console.log(rows.sort().join("\n"));
