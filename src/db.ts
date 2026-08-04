import { pool } from "./pgPool";
import type { AuditEvent, Call, CallStatus, EntryMode, Prediction, Visibility } from "./types";

// Applied by scripts/migrate.ts. Every statement is idempotent (CREATE TABLE
// IF NOT EXISTS, etc.) so this can run on every deploy without a separate
// migration-tracking table. Fine at this project's size; revisit if the
// schema starts changing weekly.
export const schemaSql = `
CREATE TABLE IF NOT EXISTS slack_installations (
  team_id      TEXT PRIMARY KEY,
  installation JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calls (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  thread_ts     TEXT,
  question      TEXT NOT NULL,
  criteria      TEXT,
  creator_id    TEXT NOT NULL,
  reviewer_id   TEXT NOT NULL,
  entry_mode    TEXT NOT NULL CHECK (entry_mode IN ('proxy', 'channel')),
  visibility    TEXT NOT NULL CHECK (visibility IN ('sealed_until_close', 'open', 'sealed_until_result')),
  winnings      TEXT NOT NULL DEFAULT 'Bragging rights',
  closes_at     TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open',
  result_text   TEXT,
  evidence_text TEXT,
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Criteria became optional (added via a "+ Add acceptance criteria" button
-- rather than a required field). Running this against a table that's
-- already nullable is a harmless no-op, so it's safe on every deploy the
-- same way the CREATE TABLE IF NOT EXISTS statements above are.
ALTER TABLE calls ALTER COLUMN criteria DROP NOT NULL;

-- Readable per-workspace call numbers (#1, #2, ...) instead of a UUID
-- fragment, used in /calledit join/lock/resolve and shown on every card.
-- call_counters hands out the next number atomically per workspace (see
-- createCall in this file); everything below backfills any calls created
-- before this column existed and keeps the whole block safe to re-run on
-- every deploy, same convention as the rest of this file.
CREATE TABLE IF NOT EXISTS call_counters (
  workspace_id TEXT PRIMARY KEY,
  next_seq     INTEGER NOT NULL DEFAULT 1
);

ALTER TABLE calls ADD COLUMN IF NOT EXISTS seq INTEGER;

UPDATE calls c
   SET seq = sub.rn
  FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY created_at) AS rn
      FROM calls
     WHERE seq IS NULL
  ) sub
 WHERE c.id = sub.id AND c.seq IS NULL;

INSERT INTO call_counters (workspace_id, next_seq)
SELECT workspace_id, MAX(seq) + 1 FROM calls WHERE seq IS NOT NULL GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE SET next_seq = GREATEST(call_counters.next_seq, EXCLUDED.next_seq);

ALTER TABLE calls ALTER COLUMN seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS calls_workspace_seq_idx ON calls (workspace_id, seq);

CREATE INDEX IF NOT EXISTS calls_workspace_status_idx ON calls (workspace_id, status);
CREATE INDEX IF NOT EXISTS calls_closes_at_idx ON calls (closes_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS predictions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    UUID NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id    UUID NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  actor_id   TEXT,
  kind       TEXT NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_call_idx ON audit_events (call_id, created_at);

CREATE TABLE IF NOT EXISTS billing_entitlements (
  workspace_id       TEXT PRIMARY KEY,
  plan               TEXT NOT NULL DEFAULT 'trial',
  slack_workspace_hint TEXT,
  paddle_subscription_id TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Paddle's subscription payload carries current_billing_period.ends_at; without
-- storing it, a 'canceling' status had no way to know whether the paid period
-- someone already bought had actually run out yet. Same gap Ledger closed the
-- same way. NULL is treated as "unknown, don't cut off" by hasAccess() below,
-- never as "already ended".
ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

-- Anyone who completes Slack OAuth could use every command forever, whether
-- or not they ever paid: nothing checked billing_entitlements anywhere. This
-- is the trial clock hasAccess() reads; set once, on first install, by
-- installationStore.storeInstallation (never reset on a re-auth of an
-- existing row). NULL is grandfathered as unrestricted, same as Ledger,
-- rather than retroactively locking out installs that predate this column.
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
`;

/** Called once, right after a brand-new slack_installations row is first
 *  inserted (see installationStore.ts) — never on a later re-auth of an
 *  existing row, so reinstalling for new scopes doesn't quietly reset an
 *  already-running or already-consumed trial. */
export async function startTrial(workspaceId: string): Promise<void> {
  await pool.query(
    `UPDATE slack_installations SET trial_ends_at = now() + interval '30 days'
     WHERE team_id = $1 AND trial_ends_at IS NULL`,
    [workspaceId],
  );
  accessCache.delete(workspaceId);
}

const accessCache = new Map<string, { access: boolean; expiresAt: number }>();
const ACCESS_CACHE_TTL_MS = 30_000;

/** The one gate every handler that can create or change data checks first.
 *  True if paid and still within the current billing period, still inside
 *  the 30-day trial, or either row is missing/unset (fail open rather than
 *  lock someone out on a lookup gap or a pre-trial-column install). A
 *  'canceling' subscription still counts as access as long as its stored
 *  current_period_end (or the absence of one) hasn't passed, matching the
 *  site's "access runs to the end of the paid period" copy. Cached briefly
 *  since this runs on the hot path of every command, shortcut, view
 *  submission, and thread reply. */
export async function hasAccess(workspaceId: string): Promise<boolean> {
  const cached = accessCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) return cached.access;

  const [installResult, billingResult] = await Promise.all([
    pool.query(`SELECT trial_ends_at FROM slack_installations WHERE team_id = $1`, [workspaceId]),
    pool.query(
      `SELECT plan, status, current_period_end FROM billing_entitlements WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);
  const install = installResult.rows[0];
  const billing = billingResult.rows[0];

  const periodStillCurrent =
    !billing?.current_period_end || new Date(billing.current_period_end).getTime() > Date.now();
  const paidAndCurrent =
    billing?.plan === "pro" && (billing.status === "active" || billing.status === "canceling") && periodStillCurrent;

  const stillTrialing =
    !install || install.trial_ends_at === null || new Date(install.trial_ends_at).getTime() > Date.now();

  const access = paidAndCurrent || stillTrialing;
  accessCache.set(workspaceId, { access, expiresAt: Date.now() + ACCESS_CACHE_TTL_MS });
  return access;
}

/** Consistent copy for every handler that blocks on hasAccess() === false. */
export function trialEndedMessage(workspaceId: string): string {
  return (
    `Your Calledit trial has ended. Subscribe to keep using Calledit for the whole workspace: ` +
    `https://runciter.app/call?install=${workspaceId}`
  );
}

function rowToCall(r: any): Call {
  return {
    id: r.id,
    seq: Number(r.seq),
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    threadTs: r.thread_ts,
    question: r.question,
    criteria: r.criteria,
    creatorId: r.creator_id,
    reviewerId: r.reviewer_id,
    entryMode: r.entry_mode as EntryMode,
    visibility: r.visibility as Visibility,
    winnings: r.winnings,
    closesAt: r.closes_at,
    status: r.status as CallStatus,
    resultText: r.result_text,
    evidenceText: r.evidence_text,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
  };
}

function rowToPrediction(r: any): Prediction {
  return {
    id: r.id,
    callId: r.call_id,
    userId: r.user_id,
    value: r.value,
    createdAt: r.created_at,
  };
}

export async function createCall(input: {
  workspaceId: string;
  channelId: string;
  question: string;
  criteria: string | null;
  creatorId: string;
  reviewerId: string;
  entryMode: EntryMode;
  visibility: Visibility;
  winnings: string;
  closesAt: Date;
}): Promise<Call> {
  // Atomic get-and-increment: the INSERT succeeds outright for a
  // workspace's first call (seq starts at 1, counter left at 2); every
  // call after that hits the ON CONFLICT branch, which hands back the
  // counter's current value and bumps it in the same statement, so two
  // calls created at once can't collide on the same number.
  const { rows: seqRows } = await pool.query(
    `INSERT INTO call_counters (workspace_id, next_seq) VALUES ($1, 2)
     ON CONFLICT (workspace_id) DO UPDATE SET next_seq = call_counters.next_seq + 1
     RETURNING next_seq - 1 AS seq`,
    [input.workspaceId],
  );
  const seq = seqRows[0].seq as number;

  const { rows } = await pool.query(
    `INSERT INTO calls
       (workspace_id, channel_id, question, criteria, creator_id, reviewer_id,
        entry_mode, visibility, winnings, closes_at, seq)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      input.workspaceId,
      input.channelId,
      input.question,
      input.criteria,
      input.creatorId,
      input.reviewerId,
      input.entryMode,
      input.visibility,
      input.winnings,
      input.closesAt,
      seq,
    ],
  );
  return rowToCall(rows[0]);
}

export async function setCallThread(callId: string, threadTs: string): Promise<void> {
  await pool.query(`UPDATE calls SET thread_ts = $2 WHERE id = $1`, [callId, threadTs]);
}

export async function getCall(callId: string): Promise<Call | null> {
  const { rows } = await pool.query(`SELECT * FROM calls WHERE id = $1`, [callId]);
  return rows[0] ? rowToCall(rows[0]) : null;
}

// Looks a call up by its per-workspace number (shown on every card and in
// `mine`/`open` listings as #N) across the whole workspace, not just calls
// the caller happens to already be attached to. An earlier version of the
// /calledit join/lock/resolve lookup only searched the caller's own calls
// and fell back to an exact full-UUID match against a short id, which
// meant the entire point of "join a call you weren't originally part of"
// silently never worked. This version, and the id scheme itself
// (previously an 8-character UUID fragment, hard to read or type), were
// both replaced together.
export async function findCallBySeq(workspaceId: string, seq: number): Promise<Call | null> {
  if (!Number.isFinite(seq)) return null;
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE workspace_id = $1 AND seq = $2`,
    [workspaceId, seq],
  );
  return rows[0] ? rowToCall(rows[0]) : null;
}

// Used by the thread-reply listener (handlers/messages.ts) to find which
// open call a reply belongs to. Only matches open calls, so chatter in a
// thread after a call has locked or resolved is never mistaken for a
// prediction.
export async function getCallByThread(channelId: string, threadTs: string): Promise<Call | null> {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE channel_id = $1 AND thread_ts = $2 AND status = 'open'`,
    [channelId, threadTs],
  );
  return rows[0] ? rowToCall(rows[0]) : null;
}

export async function listCallsForUser(workspaceId: string, userId: string): Promise<Call[]> {
  // Postgres requires every ORDER BY expression on a SELECT DISTINCT query
  // to appear in the select list; (c.status = 'open') on its own doesn't
  // count even though c.status does via c.*. This threw a 42P10 error on
  // every single call to /calledit mine, the command never worked at all
  // until this was caught live. Naming the expression (is_open) and adding
  // it to the select list satisfies that rule; rowToCall below just ignores
  // the extra column.
  const { rows } = await pool.query(
    `SELECT DISTINCT c.*, (c.status = 'open') AS is_open
       FROM calls c
       LEFT JOIN predictions p ON p.call_id = c.id AND p.user_id = $2
      WHERE c.workspace_id = $1
        AND (c.creator_id = $2 OR c.reviewer_id = $2 OR p.user_id = $2)
      ORDER BY is_open DESC, c.closes_at ASC`,
    [workspaceId, userId],
  );
  return rows.map(rowToCall);
}

export async function listOpenCallsInChannel(channelId: string): Promise<Call[]> {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE channel_id = $1 AND status = 'open' ORDER BY closes_at ASC`,
    [channelId],
  );
  return rows.map(rowToCall);
}

export async function listCallsPastDeadline(): Promise<Call[]> {
  const { rows } = await pool.query(
    `SELECT * FROM calls WHERE status = 'open' AND closes_at <= now()`,
  );
  return rows.map(rowToCall);
}

export async function lockCall(callId: string): Promise<Call> {
  const { rows } = await pool.query(
    `UPDATE calls SET status = 'locked' WHERE id = $1 RETURNING *`,
    [callId],
  );
  return rowToCall(rows[0]);
}

export async function cancelCall(callId: string): Promise<Call> {
  const { rows } = await pool.query(
    `UPDATE calls SET status = 'cancelled' WHERE id = $1 RETURNING *`,
    [callId],
  );
  return rowToCall(rows[0]);
}

export async function resolveCall(
  callId: string,
  input: { resultText: string; evidenceText: string; resolvedBy: string },
): Promise<Call> {
  const { rows } = await pool.query(
    `UPDATE calls
        SET status = 'resolved',
            result_text = $2,
            evidence_text = $3,
            resolved_by = $4,
            resolved_at = now()
      WHERE id = $1
      RETURNING *`,
    [callId, input.resultText, input.evidenceText, input.resolvedBy],
  );
  return rowToCall(rows[0]);
}

export async function upsertPrediction(
  callId: string,
  userId: string,
  value: string,
): Promise<Prediction> {
  const { rows } = await pool.query(
    `INSERT INTO predictions (call_id, user_id, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (call_id, user_id) DO UPDATE SET value = EXCLUDED.value
     RETURNING *`,
    [callId, userId, value],
  );
  return rowToPrediction(rows[0]);
}

export async function listPredictions(callId: string): Promise<Prediction[]> {
  const { rows } = await pool.query(
    `SELECT * FROM predictions WHERE call_id = $1 ORDER BY created_at ASC`,
    [callId],
  );
  return rows.map(rowToPrediction);
}

export async function recordAuditEvent(
  callId: string,
  actorId: string | null,
  kind: AuditEvent["kind"],
  detail?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events (call_id, actor_id, kind, detail) VALUES ($1, $2, $3, $4)`,
    [callId, actorId, kind, detail ?? null],
  );
}

export async function listAuditEvents(callId: string): Promise<AuditEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM audit_events WHERE call_id = $1 ORDER BY created_at ASC`,
    [callId],
  );
  return rows.map((r) => ({
    id: r.id,
    callId: r.call_id,
    actorId: r.actor_id,
    kind: r.kind,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
