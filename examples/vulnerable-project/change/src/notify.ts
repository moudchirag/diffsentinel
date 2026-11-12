// Sends a transfer receipt. (Synthetic code for the DiffSentinel demo.)
async function postToMailService(to: string, body: string): Promise<void> {
  const res = await fetch("https://mail.example.invalid/send", { method: "POST", body: JSON.stringify({ to, body }) });
  if (!res.ok) throw new Error(`mail service returned ${res.status}`);
}

export function sendReceipt(owner: string, amount: number): void {
  // fire-and-forget: a failed request becomes an unhandled promise rejection
  postToMailService(owner, `You transferred ${amount}`);
}
