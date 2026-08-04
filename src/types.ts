// Core domain types for Calledit. Kept in one file since the model is small
// and every handler needs to agree on the same shapes.

export type EntryMode = "proxy" | "channel";
// proxy   -> the creator enters name/pick pairs directly (going round the room).
// channel -> Calledit posts the question and anyone in the channel replies with
//            their own call in the thread.

export type Visibility = "sealed_until_close" | "open" | "sealed_until_result";

export type CallStatus =
  | "open"
  | "locked"
  | "awaiting_result"
  | "under_review"
  | "resolved"
  | "consequence_pending"
  | "complete"
  | "indeterminate"
  | "cancelled";

export interface Call {
  id: string;
  workspaceId: string;
  channelId: string;
  threadTs: string | null; // set once the opening card is posted; every later
                             // message (join, lock, reveal, settle) replies here.
  question: string;
  criteria: string | null; // optional: added via the "+ Add acceptance criteria" button.
  creatorId: string;
  reviewerId: string; // defaults to creatorId if none was set explicitly.
  entryMode: EntryMode;
  visibility: Visibility;
  winnings: string; // free text, defaults to "Bragging rights".
  closesAt: Date;
  status: CallStatus;
  resultText: string | null;
  evidenceText: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface Prediction {
  id: string;
  callId: string;
  userId: string; // always a resolved Slack user id, never free text.
  value: string; // free text, whatever the person actually said.
  createdAt: Date;
}

export interface AuditEvent {
  id: string;
  callId: string;
  actorId: string | null; // null for system-generated events (e.g. auto-lock).
  kind:
    | "created"
    | "predicted"
    | "prediction_changed"
    | "joined"
    | "declined"
    | "locked"
    | "resolved"
    | "consequence_marked_done"
    | "cancelled";
  detail: string | null;
  createdAt: Date;
}
