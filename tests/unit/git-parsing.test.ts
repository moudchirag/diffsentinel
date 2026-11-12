import { describe, expect, it } from "vitest";
import { parseBinaryPaths, parseNameStatus } from "../../src/infrastructure/git/git-cli.provider.js";

describe("parseNameStatus", () => {
  it("parses add/modify/delete with spaces and unicode in paths", () => {
    const out = ["A", "src/new file.ts", "M", "src/ünï.ts", "D", "old.ts", ""].join("\0");
    expect(parseNameStatus(out)).toEqual([
      { path: "src/new file.ts", status: "added" },
      { path: "src/ünï.ts", status: "modified" },
      { path: "old.ts", status: "deleted" },
    ]);
  });

  it("parses renames and copies with both paths", () => {
    const out = ["R095", "a/old name.ts", "b/new.ts", "C100", "x.ts", "y.ts", "M", "z.ts", ""].join("\0");
    expect(parseNameStatus(out)).toEqual([
      { path: "b/new.ts", oldPath: "a/old name.ts", status: "renamed" },
      { path: "y.ts", oldPath: "x.ts", status: "copied" },
      { path: "z.ts", status: "modified" },
    ]);
  });

  it("normalizes backslashes and handles empty output", () => {
    expect(parseNameStatus(["M", "a\\b.ts", ""].join("\0"))[0]?.path).toBe("a/b.ts");
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("parseBinaryPaths", () => {
  it("flags only '-\\t-' entries, including renamed binaries", () => {
    const out = ["1\t2\tsrc/a.ts", "-\t-\timg/logo.png", "-\t-\t", "img/old.png", "img/new.png", "3\t0\tb.ts", ""].join("\0");
    expect([...parseBinaryPaths(out)].sort()).toEqual(["img/logo.png", "img/new.png"]);
  });
});
