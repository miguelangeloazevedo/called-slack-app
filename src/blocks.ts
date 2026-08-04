import type { KnownBlock } from "@slack/bolt";
import type { Call, Prediction } from "./types";

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
  const showValues = call.visibility === "open";
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

export function settleBlocks(call: Call, predictions: Prediction[]): KnownBlock[] {
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
  ];
}
