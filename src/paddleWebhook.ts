import crypto from "crypto";
import type { Request, Response } from "express";
import { pool } from "./pgPool";

// Paddle billing webhook. Same reconciliation shape as Ledger: a checkout
// carries either a verified Slack team id (customData.slackInstallId, set
// when the buyer arrived at /call already OAuth-installed) or, failing
// that, an unverified free-text workspace hint the buyer typed in by hand.
// Only the verified id gets an entitlement applied automatically; a hint
// alone is logged for manual reconciliation rather than trusted outright.
export function verifyPaddleSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  // Paddle's header looks like "ts=173...;h1=abcdef..."
  const parts = Object.fromEntries(
    signatureHeader.split(";").map((p) => p.split("=") as [string, string]),
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const signedPayload = `${ts}:${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");

  // Constant-time comparison, not a plain string equality check, since this
  // is guarding against a real forged-webhook attack surface.
  const expectedBuf = Buffer.from(expected, "hex");
  const actualBuf = Buffer.from(h1, "hex");
  return expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);
}

export async function handlePaddleWebhook(req: Request, res: Response) {
  const signature = req.header("paddle-signature");
  const rawBody = req.body as Buffer; // mounted with express.raw() in app.ts

  if (!verifyPaddleSignature(rawBody, signature)) {
    res.status(401).send("invalid signature");
    return;
  }

  const event = JSON.parse(rawBody.toString("utf8"));
  const eventType = event.event_type as string;
  const data = event.data ?? {};
  const customData = data.custom_data ?? {};
  const slackInstallId: string | undefined = customData.slackInstallId;
  const slackWorkspaceHint: string | undefined = customData.slackWorkspaceHint;

  if (!slackInstallId) {
    console.warn(
      `[paddle-webhook] No verified slackInstallId on event ${event.event_id} (${eventType}). ` +
        `Unverified hint present: ${JSON.stringify(slackWorkspaceHint ?? "none")}. ` +
        `Entitlement NOT applied, needs manual reconciliation.`,
    );
    res.status(200).send("ok"); // acknowledge receipt either way, Paddle retries on non-2xx
    return;
  }

  switch (eventType) {
    case "subscription.created":
    case "subscription.activated":
    case "subscription.updated":
      await pool.query(
        `INSERT INTO billing_entitlements (workspace_id, plan, paddle_subscription_id, status, updated_at)
         VALUES ($1, 'pro', $2, 'active', now())
         ON CONFLICT (workspace_id) DO UPDATE
           SET plan = 'pro', paddle_subscription_id = $2, status = 'active', updated_at = now()`,
        [slackInstallId, data.id],
      );
      break;

    case "subscription.canceled":
      // Hold access until period end rather than revoking immediately;
      // Paddle sends this the moment cancellation is scheduled, not when
      // the paid period actually runs out.
      await pool.query(
        `UPDATE billing_entitlements SET status = 'canceling', updated_at = now() WHERE workspace_id = $1`,
        [slackInstallId],
      );
      break;

    default:
      // Other event types (transaction.completed, etc.) are informational
      // for now; entitlement state is driven off subscription.* only.
      break;
  }

  res.status(200).send("ok");
}
