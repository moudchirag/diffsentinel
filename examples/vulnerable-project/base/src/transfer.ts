import type { Db } from "./db.js";
import { getAccount } from "./accounts.js";

export async function transfer(db: Db, fromId: string, toId: string, amount: number): Promise<void> {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be a positive number");
  const from = await getAccount(db, fromId);
  const to = await getAccount(db, toId);
  if (!from || !to) throw new Error("Account not found");
  if (from.balance < amount) throw new Error("Insufficient funds");

  await db.execute("BEGIN");
  try {
    await db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, fromId]);
    await db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, toId]);
    await db.execute("COMMIT");
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
}
