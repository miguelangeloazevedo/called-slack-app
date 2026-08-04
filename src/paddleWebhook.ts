import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import { pool } from "./pgPool";

// Reads the request body as a raw Buffer. Registered as a SocketModeReceiver
// customRoute (see app.ts), so this gets Node's bare IncomingMessage, not an
// Express request, there is no express.raw() middleware doing this for us.
// Reading it raw, rather than parsing JSON straight off the stream, matters
// because Paddle's signature is computed over the exact undecoded bytes.
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

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

export async function handlePaddleWebhook(req: IncomingMessage, res: ServerResponse) {
  const rawBody = await readRawBody(req);
  const signatureHeader = req.headers["paddle-signature"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

  if (!verifyPaddleSignature(rawBody, signature)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("invalid signature");
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
    // acknowledge receipt either way, Paddle retries on non-2xx
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Paddle subscription objects carry the paid-through date at
  // current_billing_period.ends_at. Without recording it, hasAccess() (see
  // db.ts) had no way to know whether a 'canceling' subscription's period
  // had actually run out yet, only that cancellation had been requested.
  const currentPeriodEnd: string | null = data.current_billing_period?.ends_at ?? null;

  switch (eventType) {
    case "subscription.created":
    case "subscription.activated":
    case "subscription.updated":
      await pool.query(
        `INSERT INTO billing_entitlements (workspace_id, plan, paddle_subscription_id, status, current_period_end, updated_at)
         VALUES ($1, 'pro', $2, 'active', $3, now())
         ON CONFLICT (workspace_id) DO UPDATE
           SET plan = 'pro', paddle_subscription_id = $2, status = 'active',
               current_period_end = COALESCE($3, billing_entitlements.current_period_end), updated_at = now()`,
        [slackInstallId, data.id, currentPeriodEnd],
      );
      break;

    case "subscription.canceled":
      // Hold access until period end rather than revoking immediately;
      // Paddle sends this the moment cancellation is scheduled, not when
      // the paid period actually runs out. hasAccess() checks
      // current_period_end directly, so no separate expiry sweep is needed
      // for this to actually cut off access once the period passes.
      await pool.query(
        `UPDATE billing_entitlements
            SET status = 'canceling', current_period_end = COALESCE($2, current_period_end), updated_at = now()
          WHERE workspace_id = $1`,
        [slackInstallId, currentPeriodEnd],
      );
      break;

    default:
      // Other event types (transaction.completed, etc.) are informational
      // for now; entitlement state is driven off subscription.* only.
      break;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}
