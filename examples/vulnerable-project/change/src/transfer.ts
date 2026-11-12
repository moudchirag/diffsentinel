import type { Db } from "./db.js";
import { getAccount } from "./accounts.js";
import { sendReceipt } from "./notify.js";

export async function transfer(db: Db, fromId: string, toId: string, amount: number): Promise<void> {
  const from = await getAccount(db, fromId);
  const to = await getAccount(db, toId);
  if (!from || !to) throw new Error("Account not found");

  await db.execute("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, fromId]);
  await db.execute("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, toId]);

  sendReceipt(from.owner, amount);
}
