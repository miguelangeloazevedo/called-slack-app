import type { KnownBlock } from "@slack/bolt";
import type { AuditEvent, Call, Prediction } from "./types";

// Block Kit builders for every card Calledit posts. Kept separate from the
// handlers that call them so the visual shape of a call is defined in one
// place and reused everywhere (open card, lock notice, resolve card).

function formatDeadline(d: Date): string {
  // Slack's own date formatting token, renders in each viewer's local time
  // and falls back to the literal text if their client can't parse it.
  const ts = Math.floor(d.getTime() / 1000);
  return `<!date^${ts}^{date_short_pretty} at {time}|${d.toISOString()}>`;
}

export function openCallBlocks(call: Call): KnownBlock[] {
  const fields = [{ type: "mrkdwn" as const, text: `*Closes*\n${formatDeadline(call.closesAt)}` }];
  if (call.criteria) {
    fields.push({ type: "mrkdwn" as const, text: `*Judged by*\n${call.criteria}` });
  }

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:bell: *OPEN CALL*\n${call.question}` },
    },
    { type: "section", fields },
  ];

  if (call.reviewerId) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Reviewer: <@${call.reviewerId}>` }],
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Winnings: ${call.winnings}` }],
  });

  // The call number is what /calledit join/lock/resolve actually take as
  // an argument; without showing it here, using those commands meant
  // running /calledit open or /calledit mine first just to find it.
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `#${call.seq}  ·  join with \`/calledit join ${call.seq}\`` },
    ],
  });

  if (call.entryMode === "channel") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Make your call" },
          action_id: "call_join",
          value: call.id,
          style: "primary",
        },
      ],
    });
  }

  return blocks;
}

// Everything currently open in one channel, whoever started it, with every
// person's call so far under each one. This is what /calledit open renders
// (see handlers/commands.ts); a plain list of questions wasn't enough to
// answer "what's actually going on right now", this is meant to be read on
// its own without needing to open each call individually.
export function openCallsOverviewBlocks(
  calls: Call[],
  predictionsByCallId: Map<string, Prediction[]>,
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🔔 ${calls.length} open in this channel` },
    },
  ];

  calls.forEach((call, i) => {
    if (i > 0) blocks.push({ type: "divider" });

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*#${call.seq}  ${call.question}*` },
    });

    const meta = [`Closes ${formatDeadline(call.closesAt)}`, `Winnings: ${call.winnings}`];
    if (call.reviewerId) meta.push(`Reviewer <@${call.reviewerId}>`);
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: meta.join("   ·   ") }],
    });

    const predictions = predictionsByCallId.get(call.id) ?? [];
    const showValues = call.visibility === "open";
    const lines = predictions.length
      ? predictions
          .map((p) => (showValues ? `• <@${p.userId}> — ${p.value}` : `• <@${p.userId}> — 🔒 sealed`))
          .join("\n")
      : "_Nobody's called it yet._";
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Calls so far*\n${lines}` },
    });

    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `join with \`/calledit join ${call.seq}\`` }],
    });
  });

  return blocks;
}

export function lockNoticeBlocks(call: Call, predictions: Prediction[]): KnownBlock[] {
  // "open" was always visible. "sealed_until_close" means exactly that:
  // sealed only until the call closes, this lock notice IS that moment, so
  // it reveals here too. Only "sealed_until_result" stays hidden past this
  // point, until settleBlocks reveals it at resolve time.
  const showValues = call.visibility === "open" || call.visibility === "sealed_until_close";
  const lines = predictions
    .map((p) => (showValues ? `<@${p.userId}>: ${p.value}` : `<@${p.userId}>: hidden`))
    .join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:lock: *CALL LOCKED*\nPredictions are closed.\n${lines || "_No one called it._"}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: showValues
            ? "Predictions above."
            : "Predictions stay hidden until this call is settled.",
        },
      ],
    },
  ];
}

export function cancelNoticeBlocks(call: Call): KnownBlock[] {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:no_entry_sign: *CALL CANCELLED*\n${call.question}` },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "This call is void. No result will be recorded." }],
    },
  ];
}

// One line per audit_events row, in plain language. This is what makes the
// "visible audit trail" the site describes actually visible: the events
// were always being recorded (recordAuditEvent, called from every handler
// that touches a call), but nothing ever read listAuditEvents back out
// until now, so the log existed only in Postgres, never in Slack.
function describeAuditEvent(e: AuditEvent): string {
  const who = e.actorId ? `<@${e.actorId}>` : "Calledit";
  const verbs: Record<AuditEvent["kind"], string> = {
    created: "opened this call",
    predicted: "called it",
    prediction_changed: "updated their call",
    joined: "joined the call",
    declined: "declined to call it",
    locked: e.actorId ? "locked the call" : "auto-locked the call at the deadline",
    resolved: "resolved the call",
    consequence_marked_done: "marked the consequence done",
    cancelled: "cancelled the call",
  };
  const when = formatDeadline(e.createdAt);
  const detail = e.detail ? ` (${e.detail})` : "";
  return `${who} ${verbs[e.kind]}${detail} — ${when}`;
}

export function auditTrailBlocks(events: AuditEvent[]): KnownBlock[] {
  if (!events.length) return [];
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `*Audit trail*\n${events.map(describeAuditEvent).join("\n")}` }],
    },
  ];
}

export function settleBlocks(
  call: Call,
  predictions: Prediction[],
  auditEvents: AuditEvent[] = [],
): KnownBlock[] {
  const lines = predictions.map((p) => `<@${p.userId}> called: ${p.value}`).join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:checkered_flag: *RESULT*\n${call.resultText}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines || "_No one called it._" },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Evidence: ${call.evidenceText ?? "not provided"}` },
        { type: "mrkdwn", text: `Settled by <@${call.resolvedBy}>` },
      ],
    },
    ...auditTrailBlocks(auditEvents),
  ];
}
