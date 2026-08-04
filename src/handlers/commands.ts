import type { App } from "@slack/bolt";
import {
  findCallBySeq,
  listCallsForUser,
  listOpenCallsInChannel,
  listPredictions,
  lockCall,
  recordAuditEvent,
} from "../db";
import { buildNewCallModal, buildResolveModal, DEFAULT_PROXY_ROWS } from "../modals";
import { lockNoticeBlocks } from "../blocks";

export function registerCommandHandlers(app: App) {
  app.command("/calledit", async ({ ack, command, client, body }) => {
    await ack();

    const [sub, ...rest] = command.text.trim().split(/\s+/).filter(Boolean);
    const arg = rest.join(" ");

    // Temporary: nothing here logs on success normally, which made a
    // silent failure indistinguishable from "never dispatched at all".
    // Remove once the join issue is confirmed fixed.
    console.log(
      `[commands] raw=${JSON.stringify(command.text)} sub=${JSON.stringify(sub)} arg=${JSON.stringify(arg)} channel=${command.channel_id}`,
    );

    try {
    switch (sub) {
      case undefined:
        await client.views.open({
          trigger_id: body.trigger_id,
          view: buildNewCallModal({
            channelId: command.channel_id,
            entryMode: "proxy",
            proxyRowCount: DEFAULT_PROXY_ROWS,
            showReviewer: false,
            showCriteria: false,
          }),
        });
        return;

      case "mine": {
        const calls = await listCallsForUser(command.team_id, command.user_id);
        const text = calls.length
          ? calls
              .map(
                (c) =>
                  `*${c.status.toUpperCase()}* #${c.seq} ${c.question}\n   ↳ \`/calledit join ${c.seq}\` to add or update your call`,
              )
              .join("\n\n")
          : "You haven't made or joined any calls yet.";
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text,
        });
        return;
      }

      case "open": {
        const calls = await listOpenCallsInChannel(command.channel_id);
        const text = calls.length
          ? calls.map((c) => `#${c.seq} ${c.question}`).join("\n")
          : "No calls are open in this channel right now.";
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text,
        });
        return;
      }

      case "lock": {
        const call = await findCallBySeq(command.team_id, Number(arg));
        if (!call) return ephemeralNotFound(client, command);
        await lockCall(call.id);
        await recordAuditEvent(call.id, command.user_id, "locked", "manual lock");
        if (call.threadTs) {
          const predictions = await listPredictions(call.id);
          await client.chat.postMessage({
            channel: call.channelId,
            thread_ts: call.threadTs,
            blocks: lockNoticeBlocks(call, predictions),
            text: "Call locked.",
          });
        }
        return;
      }

      case "resolve": {
        const call = await findCallBySeq(command.team_id, Number(arg));
        if (!call) return ephemeralNotFound(client, command);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: buildResolveModal(call.id, call.question),
        });
        return;
      }

      case "join": {
        const call = await findCallBySeq(command.team_id, Number(arg));
        if (!call) return ephemeralNotFound(client, command);
        // The actual pick is collected in a follow-up reply rather than as
        // a command argument, so it isn't limited to a single line pasted
        // after the id. handlers/messages.ts is what actually turns that
        // reply into a recorded prediction.
        //
        // Ephemeral messages have to be posted to the channel the command
        // was actually run in, not the call's own channel, an earlier
        // version posted to call.channelId instead, which meant running
        // /calledit join from anywhere other than the exact channel the
        // call lives in silently sent the prompt somewhere the caller
        // wasn't looking. thread_ts only makes sense when those two
        // channels are the same, a thread_ts from a different channel
        // isn't valid here.
        const sameChannel = call.channelId === command.channel_id;
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: sameChannel
            ? `What's your call on "${call.question}"? Reply in this thread and I'll record it.`
            : `What's your call on "${call.question}"? That call is in <#${call.channelId}>, reply in its thread there and I'll record it.`,
          thread_ts: sameChannel ? call.threadTs ?? undefined : undefined,
        });
        await recordAuditEvent(call.id, command.user_id, "joined", "via /calledit join");
        return;
      }

      default:
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text: `Unrecognised subcommand "${sub}". Try /calledit, /calledit mine, /calledit open, /calledit lock <id>, /calledit resolve <id>, or /calledit join <id>.`,
        });
    }
    } catch (err) {
      // Temporary, alongside the log above: make absolutely sure nothing
      // in this handler can fail silently while diagnosing the join
      // command going quiet with no error and no response.
      console.error(`[commands] handler threw for sub=${JSON.stringify(sub)} arg=${JSON.stringify(arg)}`, err);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Something went wrong handling that: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

async function ephemeralNotFound(client: App["client"], command: { channel_id: string; user_id: string }) {
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: "Couldn't find that call. Use /calledit mine to see your call numbers.",
  });
}
