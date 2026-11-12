import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentOrchestrator } from "../../src/agent/agent-orchestrator.js";
import type { ModelSession, ModelTurn, SessionInput } from "../../src/agent/model-session.js";
import { parseModelReview } from "../../src/agent/report-schema.js";
import { ToolRegistry } from "../../src/agent/tool-registry.js";
import { AgentLimitExceededError, InvalidModelResponseError } from "../../src/domain/review-errors.js";
import { calculateOverallRisk } from "../../src/domain/severity.js";

const goodReview = {
  summary: "One issue.",
  findings: [
    {
      id: "F1",
      category: "security",
      severity: "high",
      title: "SQL injection",
      file: "src/a.ts",
      lineStart: 3,
      lineEnd: 4,
      description: "d",
      evidence: "e",
      recommendation: "r",
      confidence: 0.9,
    },
  ],
  missingTests: [],
  styleIssues: [],
};
const emptyReview = { summary: "Clean.", findings: [], missingTests: [], styleIssues: [] };

/** Scripted fake model: returns the queued turns in order and records every input it receives. */
function fakeSession(turns: Array<Partial<ModelTurn>>): ModelSession & { inputs: SessionInput[] } {
  const inputs: SessionInput[] = [];
  let i = 0;
  return {
    inputs,
    async send(input) {
      inputs.push(input);
      const t = turns[i++] ?? turns[turns.length - 1] ?? {};
      return { text: t.text ?? "", functionCalls: t.functionCalls ?? [] };
    },
  };
}

function registryWith(handler = vi.fn(async ({ path }: { path: string }) => ({ output: { path }, target: path, summary: "ok", evidence: "code" }))) {
  const reg = new ToolRegistry().register({
    declaration: { name: "read_changed_file", description: "x", parametersJsonSchema: { type: "object" } },
    schema: z.object({ path: z.string() }).strict(),
    handler,
  });
  return { reg, handler };
}

const limits = { maxAgentIterations: 6, maxToolCalls: 3, maxToolsPerIteration: 2 };
const call = (name: string, args: unknown, id?: string) => ({ name, args, ...(id ? { id } : {}) });

describe("AgentOrchestrator", () => {
  it("logs live progress while a slow model request is in flight, then stops the heartbeat", async () => {
    const { reg } = registryWith();
    const slow: ModelSession = {
      async send() {
        await new Promise((r) => setTimeout(r, 60));
        return { text: "", functionCalls: [call("submit_review", emptyReview)] };
      },
    };
    const logs: string[] = [];
    await new AgentOrchestrator(reg, { ...limits, maxAgentIterations: 1 }, (m) => logs.push(m), 15).run(slow, "diff");
    const afterRun = logs.length;
    await new Promise((r) => setTimeout(r, 50));

    expect(logs[0]).toBe("[turn 1] waiting for the model (final turn: submit_review required)...");
    expect(logs.some((l) => l.startsWith("  ... still waiting for the model"))).toBe(true);
    expect(logs.at(-1)).toMatch(/^\[turn 1\] model -> submit_review/);
    expect(logs.length).toBe(afterRun); // heartbeat cleared, no lines after the run
  });

  it("validates, executes a requested tool locally, and returns the result to the model", async () => {
    const { reg, handler } = registryWith();
    const session = fakeSession([
      { functionCalls: [call("read_changed_file", { path: "src/a.ts" }, "c1")] },
      { functionCalls: [call("submit_review", goodReview)] },
    ]);
    const result = await new AgentOrchestrator(reg, limits).run(session, "diff");

    expect(handler).toHaveBeenCalledWith({ path: "src/a.ts" });
    expect(result.toolCalls).toMatchObject([{ turn: 1, name: "read_changed_file", ok: true, target: "src/a.ts", summary: "ok" }]);
    expect(result.toolEvidence).toEqual(["code"]);
    expect(result.review.findings).toHaveLength(1);
    // the tool result was sent back to the model, with the matching call id
    expect(session.inputs[1]).toEqual({
      kind: "toolResults",
      results: [{ id: "c1", name: "read_changed_file", response: { output: { path: "src/a.ts" } } }],
    });
  });

  it("rejects unknown tools without executing anything and keeps going", async () => {
    const { reg, handler } = registryWith();
    const session = fakeSession([
      { functionCalls: [call("run_shell", { cmd: "rm -rf /" })] },
      { functionCalls: [call("submit_review", emptyReview)] },
    ]);
    const result = await new AgentOrchestrator(reg, limits).run(session, "diff");
    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCalls[0]).toMatchObject({ name: "run_shell", ok: false });
    const sent = session.inputs[1];
    expect(sent?.kind === "toolResults" && sent.results[0]?.response["error"]).toMatch(/Unknown tool/);
  });

  it("rejects invalid arguments (wrong type, extra keys)", async () => {
    const { reg, handler } = registryWith();
    const session = fakeSession([
      { functionCalls: [call("read_changed_file", { path: 42 }), call("read_changed_file", { path: "a", extra: 1 })] },
      { functionCalls: [call("submit_review", emptyReview)] },
    ]);
    const result = await new AgentOrchestrator(reg, limits).run(session, "diff");
    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCalls.every((t) => !t.ok)).toBe(true);
  });

  it("reports tool failures to the model without leaking absolute paths", async () => {
    const { reg } = registryWith(
      vi.fn(async () => {
        throw new Error("boom at C:\\Users\\someone\\secret\\file.ts");
      }),
    );
    const session = fakeSession([
      { functionCalls: [call("read_changed_file", { path: "a" })] },
      { functionCalls: [call("submit_review", emptyReview)] },
    ]);
    await new AgentOrchestrator(reg, limits).run(session, "diff");
    const sent = session.inputs[1];
    const err = sent?.kind === "toolResults" ? String(sent.results[0]?.response["error"]) : "";
    expect(err).toContain("<path>");
    expect(err).not.toContain("someone");
  });

  it("caps tool calls per turn", async () => {
    const { reg, handler } = registryWith();
    const session = fakeSession([
      { functionCalls: [call("read_changed_file", { path: "a" }), call("read_changed_file", { path: "b" }), call("read_changed_file", { path: "c" })] },
      { functionCalls: [call("submit_review", emptyReview)] },
    ]);
    await new AgentOrchestrator(reg, limits).run(session, "diff");
    expect(handler).toHaveBeenCalledTimes(2);
    const sent = session.inputs[1];
    expect(sent?.kind === "toolResults" && sent.results[2]?.response["error"]).toMatch(/Per-turn limit/);
  });

  it("tells the model once when the total budget is exhausted, then aborts if it persists", async () => {
    const { reg } = registryWith();
    const more = { functionCalls: [call("read_changed_file", { path: "a" })] };
    const session = fakeSession([more, more, more, more, more]);
    await expect(new AgentOrchestrator(reg, limits).run(session, "diff")).rejects.toBeInstanceOf(AgentLimitExceededError);
  });

  it("lets the model finish after being told the budget is exhausted", async () => {
    const { reg } = registryWith();
    const more = { functionCalls: [call("read_changed_file", { path: "a" })] };
    const session = fakeSession([more, more, more, more, { functionCalls: [call("submit_review", emptyReview)] }]);
    const result = await new AgentOrchestrator(reg, { ...limits, maxAgentIterations: 6 }).run(session, "diff");
    expect(result.toolCalls).toHaveLength(3);
  });

  it("asks for one repair when submit_review is invalid, then fails if still invalid", async () => {
    const { reg } = registryWith();
    const bad = { functionCalls: [call("submit_review", { summary: "x" })] };
    const session = fakeSession([bad, bad]);
    await expect(new AgentOrchestrator(reg, limits).run(session, "diff")).rejects.toBeInstanceOf(InvalidModelResponseError);
    expect(session.inputs).toHaveLength(2);
  });

  it("accepts a corrected review after one repair", async () => {
    const { reg } = registryWith();
    const session = fakeSession([
      { functionCalls: [call("submit_review", { ...goodReview, findings: [{ ...goodReview.findings[0], confidence: 7 }] })] },
      { functionCalls: [call("submit_review", goodReview)] },
    ]);
    const result = await new AgentOrchestrator(reg, limits).run(session, "diff");
    expect(result.review.findings[0]?.confidence).toBe(0.9);
  });

  it("nudges once when the model answers in prose, accepts JSON text, otherwise fails", async () => {
    const { reg } = registryWith();
    const nudged = fakeSession([{ text: "Looks fine to me!" }, { functionCalls: [call("submit_review", emptyReview)] }]);
    await expect(new AgentOrchestrator(reg, limits).run(nudged, "diff")).resolves.toBeDefined();

    const json = fakeSession([{ text: "```json\n" + JSON.stringify(emptyReview) + "\n```" }]);
    await expect(new AgentOrchestrator(reg, limits).run(json, "diff")).resolves.toBeDefined();

    const prose = fakeSession([{ text: "nope" }]);
    await expect(new AgentOrchestrator(reg, limits).run(prose, "diff")).rejects.toBeInstanceOf(InvalidModelResponseError);
  });

  it("never claims completion when iterations run out", async () => {
    const { reg } = registryWith();
    const session = fakeSession([{ functionCalls: [call("read_changed_file", { path: "a" })] }]);
    await expect(
      new AgentOrchestrator(reg, { maxAgentIterations: 2, maxToolCalls: 10, maxToolsPerIteration: 2 }).run(session, "diff"),
    ).rejects.toBeInstanceOf(AgentLimitExceededError);
  });
});

describe("report schema", () => {
  it("accepts a valid review", () => {
    expect(parseModelReview(goodReview).findings[0]?.id).toBe("F1");
  });
  it("accepts null line numbers and empty arrays", () => {
    const r = parseModelReview({ ...emptyReview, findings: [{ ...goodReview.findings[0], lineStart: null, lineEnd: null }] });
    expect(r.findings[0]?.lineStart).toBeNull();
  });
  it.each([
    ["bad severity", { severity: "urgent" }],
    ["bad category", { category: "style" }],
    ["confidence > 1", { confidence: 1.5 }],
    ["confidence < 0", { confidence: -0.1 }],
    ["zero line", { lineStart: 0 }],
    ["fractional line", { lineStart: 1.5 }],
    ["lineEnd < lineStart", { lineStart: 9, lineEnd: 2 }],
    ["empty evidence", { evidence: "" }],
  ])("rejects %s", (_name, patch) => {
    expect(() => parseModelReview({ ...goodReview, findings: [{ ...goodReview.findings[0], ...patch }] })).toThrow();
  });
  it("rejects missing arrays", () => {
    expect(() => parseModelReview({ summary: "x", findings: [] })).toThrow();
  });
});

describe("calculateOverallRisk", () => {
  it("is the highest severity present, else low", () => {
    expect(calculateOverallRisk([])).toBe("low");
    expect(calculateOverallRisk([{ severity: "low" }, { severity: "medium" }])).toBe("medium");
    expect(calculateOverallRisk([{ severity: "medium" }, { severity: "high" }, { severity: "low" }])).toBe("high");
    expect(calculateOverallRisk([{ severity: "high" }, { severity: "critical" }])).toBe("critical");
  });
});
