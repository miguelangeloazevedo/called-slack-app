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
  criteria      TEXT NOT NULL,
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
`;

function rowToCall(r: any): Call {
  return {
    id: r.id,
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
  criteria: string;
  creatorId: string;
  reviewerId: string;
  entryMode: EntryMode;
  visibility: Visibility;
  winnings: string;
  closesAt: Date;
}): Promise<Call> {
  const { rows } = await pool.query(
    `INSERT INTO calls
       (workspace_id, channel_id, question, criteria, creator_id, reviewer_id,
        entry_mode, visibility, winnings, closes_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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

export async function listCallsForUser(workspaceId: string, userId: string): Promise<Call[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT c.*
       FROM calls c
       LEFT JOIN predictions p ON p.call_id = c.id AND p.user_id = $2
      WHERE c.workspace_id = $1
        AND (c.creator_id = $2 OR c.reviewer_id = $2 OR p.user_id = $2)
      ORDER BY (c.status = 'open') DESC, c.closes_at ASC`,
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
