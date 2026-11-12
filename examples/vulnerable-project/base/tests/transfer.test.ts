import { describe, expect, it } from "vitest";
import { transfer } from "../src/transfer.js";
import type { Db } from "../src/db.js";

function fakeDb(balances: Record<string, number>): Db {
  return {
    async query(_sql, params) {
      const id = String((params ?? [])[0]);
      return id in balances ? [{ id, owner: "demo", balance: balances[id] }] : [];
    },
    async execute() {},
  } as Db;
}

describe("transfer", () => {
  it("moves money between two accounts", async () => {
    await expect(transfer(fakeDb({ a: 100, b: 0 }), "a", "b", 50)).resolves.toBeUndefined();
  });

  it("rejects a non-positive amount", async () => {
    await expect(transfer(fakeDb({ a: 100, b: 0 }), "a", "b", -5)).rejects.toThrow();
  });
});
