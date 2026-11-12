import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UnsafePathError } from "../../src/domain/review-errors.js";
import { exclusionReason } from "../../src/infrastructure/filesystem/exclusions.js";
import { redactSecrets } from "../../src/infrastructure/filesystem/redact.js";
import { RepositoryReader } from "../../src/infrastructure/filesystem/repository-reader.js";
import { findRelatedTests } from "../../src/infrastructure/filesystem/test-discovery.js";
import { createTempRepo, removeDir, writeRepoFile } from "../helpers/temp-repo.js";

describe("exclusionReason", () => {
  it.each([
    ".env",
    ".env.production",
    "config/.env.local",
    "keys/server.pem",
    "id_rsa",
    "node_modules/x/index.js",
    "dist/app.js",
    "package-lock.json",
    "public/app.min.js",
  ])("excludes %s", (p) => expect(exclusionReason(p)).not.toBeNull());

  it.each(["src/users.ts", ".env.example", "README.md", "src/build-info.ts"])("allows %s", (p) =>
    expect(exclusionReason(p)).toBeNull(),
  );
});

describe("redactSecrets", () => {
  it("redacts common secret shapes and counts them", () => {
    const input = [
      'const apiKey = "abcdefgh12345678";',
      "token: 'ghp_" + "a".repeat(36) + "'",
      "AIza" + "B".repeat(35),
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, redactions } = redactSecrets(input);
    expect(redactions).toBeGreaterThanOrEqual(4);
    expect(text).not.toContain("abcdefgh12345678");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("BEGIN RSA");
  });

  it("leaves ordinary code alone", () => {
    const { text, redactions } = redactSecrets("const total = a + b;");
    expect(redactions).toBe(0);
    expect(text).toBe("const total = a + b;");
  });
});

describe("RepositoryReader", () => {
  let root: string;
  let outside: string;
  let reader: RepositoryReader;

  beforeEach(async () => {
    root = await createTempRepo();
    outside = await createTempRepo("ds-outside-");
    await writeRepoFile(root, "src/a.ts", "export const a = 1;\n");
    await writeRepoFile(root, ".env", "SECRET=1\n");
    await writeRepoFile(root, "big.txt", "x".repeat(5000));
    await writeRepoFile(root, "bin.dat", Buffer.from([1, 2, 0, 3]));
    await writeRepoFile(outside, "secret.txt", "top secret");
    reader = await RepositoryReader.create(root, 1000);
  });
  afterEach(async () => {
    await removeDir(root);
    await removeDir(outside);
  });

  const allow = (...p: string[]) => new Set(p);

  it("reads an allowlisted file", async () => {
    const f = await reader.read("src/a.ts", allow("src/a.ts"));
    expect(f.content).toContain("export const a");
    expect(f.truncated).toBe(false);
  });

  it("normalizes Windows separators", async () => {
    const f = await reader.read("src\\a.ts", allow("src/a.ts"));
    expect(f.path).toBe("src/a.ts");
  });

  it.each(["../x", "src/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "a\0b", ""])(
    "rejects unsafe path %j",
    async (p) => {
      await expect(reader.read(p, allow(p))).rejects.toBeInstanceOf(UnsafePathError);
    },
  );

  it("rejects files that are not on the allowlist", async () => {
    await expect(reader.read("src/a.ts", allow("other.ts"))).rejects.toBeInstanceOf(UnsafePathError);
  });

  it("rejects excluded files even when allowlisted", async () => {
    await expect(reader.read(".env", allow(".env"))).rejects.toThrow(/excluded/);
  });

  it("truncates oversized files and says so", async () => {
    const f = await reader.read("big.txt", allow("big.txt"));
    expect(f.truncated).toBe(true);
    expect(f.bytesRead).toBe(1000);
    expect(f.totalBytes).toBe(5000);
  });

  it("rejects binary files", async () => {
    await expect(reader.read("bin.dat", allow("bin.dat"))).rejects.toThrow(/binary/);
  });

  it("rejects missing files", async () => {
    await expect(reader.read("nope.ts", allow("nope.ts"))).rejects.toThrow(/does not exist/);
  });

  it("rejects a symlink that escapes the repository", async (ctx) => {
    try {
      await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      ctx.skip(); // Windows without developer mode / admin cannot create symlinks
      return;
    }
    await expect(reader.read("link.txt", allow("link.txt"))).rejects.toThrow(/outside the repository/);
  });

  it("rejects a symlink aliasing an excluded file", async (ctx) => {
    try {
      await symlink(path.join(root, ".env"), path.join(root, "innocent.txt"));
    } catch {
      ctx.skip();
      return;
    }
    await expect(reader.read("innocent.txt", allow("innocent.txt"))).rejects.toThrow(/excluded/);
  });

  it("rejects directories", async () => {
    await mkdir(path.join(root, "dir"));
    await writeFile(path.join(root, "dir", "f.txt"), "x");
    await expect(reader.read("dir", allow("dir"))).rejects.toBeInstanceOf(UnsafePathError);
  });
});

describe("findRelatedTests", () => {
  const files = [
    "src/user-service.ts",
    "src/user-service.test.ts",
    "tests/unit/user-service.spec.ts",
    "tests/other.test.ts",
    "src/latest.ts",
    "tests/latest.test.ts",
    "node_modules/x/user-service.test.ts",
    "tests/user_service_test.py",
  ];
  it("matches by stem across conventions and skips excluded dirs", () => {
    const found = findRelatedTests("src/user-service.ts", files, 5);
    expect(found).toEqual(["src/user-service.test.ts", "tests/unit/user-service.spec.ts"]);
  });
  it("does not mangle names that merely end in 'test'", () => {
    expect(findRelatedTests("src/latest.ts", files, 5)).toEqual(["tests/latest.test.ts"]);
  });
  it("honours the limit and ignores test files as input", () => {
    expect(findRelatedTests("src/user-service.ts", files, 1)).toHaveLength(1);
    expect(findRelatedTests("src/user-service.test.ts", files, 5)).toEqual([]);
  });
});
