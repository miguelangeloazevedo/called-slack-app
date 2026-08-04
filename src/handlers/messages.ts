import type { App } from "@slack/bolt";
import { getCallByThread, hasAccess, recordAuditEvent, trialEndedMessage, upsertPrediction } from "../db";

// Turns a reply in a call's own thread into that person's prediction. This
// is what actually closes the loop for channel mode ("anyone in the
// channel replies with their own call") and for late joins in proxy mode
// (someone runs /calledit join, then replies in the thread): without this
// listener, the ephemeral "reply in this thread" prompt led nowhere, the
// reply was never read back into anything.
//
// Requires the channels:history / groups:history scopes and the
// message.channels / message.groups event subscription declared in
// manifest.json. Both are additions since the app was first installed, so
// existing installs need to reauthorize for this to take effect.
//
// Deliberate trade-off: any plain reply in an open call's thread is
// treated as a prediction, including from the call's own creator, there's
// no separate "I'm submitting a call now" confirmation step. That means
// casual chatter in the thread before it locks ("nice one", "what's the
// deadline again?") also gets recorded as that person's pick. An earlier
// version specifically excluded the creator to guard against exactly that,
// which backfired: it also silently blocked the creator from ever using
// /calledit join on their own call, with no error, just no tick and no
// recorded prediction. Explicit intent (running /calledit join first) is
// worth more than that guard was, so it's gone. Keeping this simple was
// judged worth the stray-chatter risk either way; a more careful version
// would need an explicit submission step, which would undercut the
// free-text, unprescriptive design this modal was built around.
export function registerMessageHandlers(app: App) {
  app.message(async ({ message, client }) => {
    // Only plain, current, threaded replies: skip edits/deletions/joins
    // (message.subtype set), anything without a user (bot messages, most
    // subtypes), and top-level messages (thread_ts === ts is the call's
    // own opening message replying to itself, not a reply to it).
    if (message.subtype !== undefined) return;
    if (!("user" in message) || !message.user) return;
    if (!("thread_ts" in message) || !message.thread_ts) return;
    if (message.thread_ts === message.ts) return;
    if (!("text" in message) || !message.text?.trim()) return;

    const call = await getCallByThread(message.channel, message.thread_ts);
    if (!call) return;

    // Second layer behind the /calledit command's own gate: a thread reply
    // is the other real way a prediction gets written, and it never went
    // through the slash command at all, so it needs its own check rather
    // than inheriting one from somewhere else.
    if (!(await hasAccess(call.workspaceId))) {
      await client.chat
        .postEphemeral({ channel: message.channel, user: message.user, text: trialEndedMessage(call.workspaceId) })
        .catch(() => {});
      return;
    }

    await upsertPrediction(call.id, message.user, message.text.trim());
    await recordAuditEvent(call.id, message.user, "predicted", "via thread reply");

    await client.reactions
      .add({ channel: message.channel, timestamp: message.ts, name: "white_check_mark" })
      .catch(() => {
        // A reaction is a nice-to-have confirmation, not worth failing the
        // whole handler over if, say, the message was already deleted.
      });
  });
}
