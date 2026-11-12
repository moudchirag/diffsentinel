import {
  ApiError,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type Content,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { ModelClient, ModelSession, ModelTurn, SessionInput } from "../../agent/model-session.js";
import type { ToolDeclaration } from "../../agent/tool-registry.js";
import { ModelRateLimitError, ModelRequestError } from "../../domain/review-errors.js";

const MAX_RETRIES = 2;
/** A single Gemini request that takes longer than this is abandoned (and may be retried within the budget). */
export const REQUEST_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Shared, hard cap on API requests (retries included) so a quota can never be overrun. */
export class RequestBudget {
  used = 0;
  constructor(readonly max: number | undefined) {}
  take(): void {
    if (this.max !== undefined && this.used >= this.max) {
      throw new ModelRequestError(`API request budget of ${this.max} reached (--max-calls); stopping to protect your quota.`);
    }
    this.used++;
  }
}

export class GeminiClient implements ModelClient {
  private readonly ai: GoogleGenAI;
  private readonly budget: RequestBudget;

  private readonly onRetry: (message: string) => void;

  constructor(
    apiKey: string,
    readonly modelName: string,
    options: { maxRequests?: number; onRetry?: (message: string) => void } = {},
  ) {
    this.onRetry = options.onRetry ?? (() => {});
    // The SDK defaults to the "v1" Gemini API, which rejects function calling
    // ("Function calling is not enabled for api version v1"). Tools need v1beta.
    this.ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta", httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
    this.budget = new RequestBudget(options.maxRequests);
  }

  requestsMade(): number {
    return this.budget.used;
  }

  startSession(options: { systemInstruction: string; tools: ToolDeclaration[] }): ModelSession {
    return new GeminiSession(this.ai, this.modelName, options, this.budget, this.onRetry);
  }
}

class GeminiSession implements ModelSession {
  /** Provider-specific conversation history. Model turns are stored exactly as returned (keeps thought signatures). */
  private readonly contents: Content[] = [];

  constructor(
    private readonly ai: GoogleGenAI,
    private readonly model: string,
    private readonly options: { systemInstruction: string; tools: ToolDeclaration[] },
    private readonly budget: RequestBudget,
    private readonly onRetry: (message: string) => void,
  ) {}

  async send(input: SessionInput): Promise<ModelTurn> {
    if (input.kind === "text") {
      this.contents.push({ role: "user", parts: [{ text: input.text }] });
    } else {
      this.contents.push({
        role: "user",
        parts: input.results.map((r) => ({
          functionResponse: { ...(r.id ? { id: r.id } : {}), name: r.name, response: r.response },
        })),
      });
    }

    const response = await this.generateWithRetry(input.forceFunction);
    const content = response.candidates?.[0]?.content;
    if (!content?.parts?.length) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "unknown";
      throw new ModelRequestError(`Gemini returned no content (reason: ${reason}).`);
    }
    this.contents.push(content);

    const parts: Part[] = content.parts;
    const functionCalls = parts
      .filter((p) => p.functionCall?.name)
      .map((p) => ({
        ...(p.functionCall?.id ? { id: p.functionCall.id } : {}),
        name: p.functionCall!.name!,
        args: p.functionCall?.args ?? {},
      }));
    const text = parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("");
    return { text, functionCalls };
  }

  private async generateWithRetry(forceFunction: string | undefined): Promise<GenerateContentResponse> {
    for (let attempt = 0; ; attempt++) {
      this.budget.take();
      try {
        return await this.ai.models.generateContent({
          model: this.model,
          contents: this.contents,
          config: {
            systemInstruction: this.options.systemInstruction,
            temperature: 0.2,
            tools: [
              {
                functionDeclarations: this.options.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  parametersJsonSchema: t.parametersJsonSchema,
                })),
              },
            ],
            toolConfig: {
              functionCallingConfig: forceFunction
                ? { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [forceFunction] }
                : { mode: FunctionCallingConfigMode.AUTO },
            },
            // We execute tools ourselves; never let the SDK call anything automatically.
            automaticFunctionCalling: { disable: true },
          },
        });
      } catch (error) {
        const mapped = mapError(error);
        if (!mapped.retryable || attempt >= MAX_RETRIES) throw mapped.error;
        const delay = 2 ** attempt * 1000 + Math.random() * 400;
        // Retries consume quota: always make them visible in the trace.
        this.onRetry(`  ! ${mapped.error.message} Retrying (${attempt + 1}/${MAX_RETRIES}) in ${(delay / 1000).toFixed(1)}s`);
        await sleep(delay);
      }
    }
  }
}

function mapError(error: unknown): { error: Error; retryable: boolean } {
  if (error instanceof ModelRequestError) return { error, retryable: false }; // e.g. budget exhausted
  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 429) {
      return {
        error: new ModelRateLimitError("Gemini rate limit / quota exceeded (HTTP 429). Wait or check your quota and plan."),
        retryable: false,
      };
    }
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(error.message)) {
      return { error: new ModelRequestError("Gemini rejected the credentials. Check GEMINI_API_KEY."), retryable: false };
    }
    if (status === 404) {
      return {
        error: new ModelRequestError(
          `Gemini model not found (HTTP 404): ${firstLine(error.message)} Check GEMINI_MODEL (npx tsx scripts/list-models.ts).`,
        ),
        retryable: false,
      };
    }
    if (status >= 500) {
      return { error: new ModelRequestError(`Gemini service error (HTTP ${status}).`, { cause: error }), retryable: true };
    }
    return {
      error: new ModelRequestError(`Gemini request rejected (HTTP ${status}): ${firstLine(error.message)}`, { cause: error }),
      retryable: false,
    };
  }
  const message = (error as Error)?.message ?? String(error);
  if ((error as Error)?.name === "AbortError" || /abort|timed? ?out/i.test(message)) {
    return {
      error: new ModelRequestError(`Gemini did not answer within ${REQUEST_TIMEOUT_MS / 1000}s (request timed out).`, { cause: error }),
      retryable: true,
    };
  }
  // Network-level failures (fetch failed, ECONNRESET, ...) are worth a bounded retry.
  return { error: new ModelRequestError(`Could not reach Gemini: ${firstLine((error as Error).message)}`, { cause: error }), retryable: true };
}

function firstLine(s: string): string {
  return (s.split("\n")[0] ?? "").slice(0, 300);
}
