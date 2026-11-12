import type { ToolDeclaration } from "./tool-registry.js";

export interface ModelFunctionCall {
  id?: string;
  name: string;
  args: unknown;
}

export interface ModelTurn {
  text: string;
  functionCalls: ModelFunctionCall[];
}

export interface ToolResponse {
  id?: string;
  name: string;
  /** Always an object: { output } on success, { error } on failure. */
  response: Record<string, unknown>;
}

export type SessionInput = ({ kind: "text"; text: string } | { kind: "toolResults"; results: ToolResponse[] }) & {
  /** When set, the model must answer by calling this function (used to force submit_review on the final turn). */
  forceFunction?: string;
};

/** One conversation with a model. The provider adapter owns the provider-specific history. */
export interface ModelSession {
  send(input: SessionInput): Promise<ModelTurn>;
}

export interface ModelClient {
  readonly modelName: string;
  /** API requests actually sent so far (including retries), if the provider tracks it. */
  requestsMade?(): number;
  startSession(options: { systemInstruction: string; tools: ToolDeclaration[] }): ModelSession;
}
