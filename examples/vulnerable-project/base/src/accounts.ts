import type { Db } from "./db.js";

export interface Account {
  id: string;
  owner: string;
  balance: number;
}

export async function getAccount(db: Db, id: string): Promise<Account | undefined> {
  const rows = await db.query<Account>("SELECT id, owner, balance FROM accounts WHERE id = ?", [id]);
  return rows[0];
}
