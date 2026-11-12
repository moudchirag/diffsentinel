import type { ModelClient, ModelFunctionCall, ModelSession, ModelTurn, SessionInput } from "../../agent/model-session.js";

/**
 * A deterministic stand-in for an LLM, used with `--provider mock`.
 * It exercises the real orchestrator, registry and every tool (including one deliberately unsafe request
 * that the guardrails must reject) WITHOUT any API call. It performs NO code analysis: its review is empty
 * and clearly labelled. Useful for rehearsing demos, CI smoke tests, and showing the agent loop offline.
 */
export class ScriptedDemoModel implements ModelClient {
  readonly modelName = "scripted-demo (NOT an AI review)";

  startSession(): ModelSession {
    return new ScriptedSession();
  }
}

interface ManifestEntry {
  status: string;
  path: string;
}

function parseManifest(message: string): ManifestEntry[] {
  const section = message.split("## Changed files manifest")[1]?.split("\n## ")[0] ?? "";
  return [...section.matchAll(/^- (\w+): (?:.* -> )?(.+)$/gm)].map((m) => ({ status: m[1] ?? "", path: (m[2] ?? "").trim() }));
}

class ScriptedSession implements ModelSession {
  private turn = 0;
  private primary = "";
  private toolsUsed = 0;

  async send(input: SessionInput): Promise<ModelTurn> {
    this.turn++;
    if (input.kind === "toolResults") this.toolsUsed += input.results.length;
    if (input.forceFunction || this.turn >= 3) return this.submit();

    if (this.turn === 1 && input.kind === "text") {
      const manifest = parseManifest(input.text).filter((f) => !f.path.split("/").pop()?.startsWith("."));
      const primary = manifest.find((f) => f.status === "modified") ?? manifest.find((f) => f.status !== "deleted");
      if (!primary) return this.submit();
      this.primary = primary.path;
      const newFile = manifest.find((f) => f.status === "untracked" || f.status === "added");
      const symbol = /export (?:async )?function (\w+)/.exec(input.text)?.[1];

      const calls: ModelFunctionCall[] = [
        { id: "t1-imports", name: "get_imports", args: { changedFile: this.primary } },
        { id: "t1-tests", name: "find_related_tests", args: { changedFile: this.primary } },
        ...(symbol ? [{ id: "t1-search", name: "search_repository", args: { query: symbol } }] : []),
        { id: "t1-read", name: "read_changed_file", args: { path: newFile?.path ?? this.primary, startLine: 1, endLine: 20 } },
      ];
      return { text: "", functionCalls: calls };
    }

    // Turn 2: one legitimate call and one deliberately unsafe request to demonstrate the guardrails.
    return {
      text: "",
      functionCalls: [
        { id: "t2-diff", name: "get_file_diff", args: { path: this.primary } },
        { id: "t2-escape", name: "read_changed_file", args: { path: "../../etc/passwd" } },
      ],
    };
  }

  private submit(): ModelTurn {
    return {
      text: "",
      functionCalls: [
        {
          id: "final",
          name: "submit_review",
          args: {
            summary:
              `SCRIPTED DEMO MODEL: exercised the agent loop and ${this.toolsUsed} tool call(s), including a deliberately unsafe ` +
              "path that the guardrails rejected. No AI analysis was performed, so no findings are reported.",
            findings: [],
            missingTests: [],
            styleIssues: [],
          },
        },
      ],
    };
  }
}
