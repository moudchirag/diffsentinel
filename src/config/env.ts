import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { ConfigError } from "../domain/review-errors.js";

export interface AppConfig {
  geminiApiKey: string;
  geminiModel: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

const PLACEHOLDERS = new Set(["replace_me", "replace_with_a_model_available_to_your_api_key", ""]);

const envSchema = z.object({
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/** Loads .env (if present) and validates configuration. Never logs the key. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, useDotenv = true): AppConfig {
  if (useDotenv) loadDotenv({ quiet: true });
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const key = parsed.data.GEMINI_API_KEY?.trim() ?? "";
  const model = parsed.data.GEMINI_MODEL?.trim() ?? "";
  if (PLACEHOLDERS.has(key)) {
    throw new ConfigError(
      "GEMINI_API_KEY is missing. Copy .env.example to .env and set your key (https://aistudio.google.com/apikey).",
    );
  }
  if (PLACEHOLDERS.has(model)) {
    throw new ConfigError(
      "GEMINI_MODEL is missing. Set it in .env to a model your API key can use (e.g. a current Gemini Flash model).",
    );
  }
  return { geminiApiKey: key, geminiModel: model, logLevel: parsed.data.LOG_LEVEL };
}
