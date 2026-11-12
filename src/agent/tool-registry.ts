import { z } from "zod";

export interface ToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema for the arguments, sent to the model. */
  parametersJsonSchema: Record<string, unknown>;
}

export interface ToolResult {
  output: unknown;
  /** Text the model saw through this tool (for evidence verification). Never logged. */
  evidence?: string;
  /** Non-sensitive description of what was targeted, for the trace. */
  target: string;
  /** One-line, non-sensitive result description for the trace, e.g. "3 matches". */
  summary: string;
}

export interface RegisteredTool<A = unknown> {
  declaration: ToolDeclaration;
  schema: z.ZodType<A>;
  handler: (args: A) => Promise<ToolResult>;
}

export type ToolOutcome =
  | { ok: true; output: unknown; target: string; summary: string; evidence?: string }
  | { ok: false; error: string; target: string };

const MAX_ERROR_LENGTH = 300;

/**
 * Maps a small allowlist of function names to application-owned handlers.
 * The model can only name a tool; it can never reach anything not registered here.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool<any>>();

  register<A>(tool: RegisteredTool<A>): this {
    this.tools.set(tool.declaration.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  declarations(): ToolDeclaration[] {
    return [...this.tools.values()].map((t) => t.declaration);
  }

  async execute(name: string, rawArgs: unknown): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool "${name.slice(0, 60)}". Available: ${[...this.tools.keys()].join(", ")}.`, target: "-" };
    }
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
      return { ok: false, error: `Invalid arguments: ${msg}`.slice(0, MAX_ERROR_LENGTH), target: "-" };
    }
    const target = describeTarget(parsed.data);
    try {
      const result = await tool.handler(parsed.data);
      return {
        ok: true,
        output: result.output,
        target: result.target,
        summary: result.summary,
        ...(result.evidence ? { evidence: result.evidence } : {}),
      };
    } catch (error) {
      // Only the message is returned to the model: no stack traces, no absolute paths.
      return { ok: false, error: sanitize((error as Error).message), target };
    }
  }
}

function describeTarget(args: unknown): string {
  if (args && typeof args === "object") {
    const first = Object.values(args as Record<string, unknown>).find((v) => typeof v === "string");
    if (typeof first === "string") return first.slice(0, 120);
  }
  return "-";
}

function sanitize(message: string): string {
  return message.replace(/[A-Za-z]:\\[^\s"']+|\/(?:[\w.-]+\/){2,}[\w.-]*/g, "<path>").slice(0, MAX_ERROR_LENGTH);
}
