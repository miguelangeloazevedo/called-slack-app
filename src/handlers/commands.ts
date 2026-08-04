import type { App } from "@slack/bolt";
import {
  findCallByShortId,
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
              .map((c) => {
                const shortId = c.id.slice(0, 8);
                return `*${c.status.toUpperCase()}* ${c.question}\n   ↳ \`/calledit join ${shortId}\` to add or update your call`;
              })
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
          ? calls.map((c) => `${c.question} (\`${c.id.slice(0, 8)}\`)`).join("\n")
          : "No calls are open in this channel right now.";
        await client.chat.postEphemeral({
          channel: command.channel_id,
          user: command.user_id,
          text,
        });
        return;
      }

      case "lock": {
        const call = await findCallByShortId(command.team_id, arg);
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
        const call = await findCallByShortId(command.team_id, arg);
        if (!call) return ephemeralNotFound(client, command);
        await client.views.open({
          trigger_id: body.trigger_id,
          view: buildResolveModal(call.id, call.question),
        });
        return;
      }

      case "join": {
        const call = await findCallByShortId(command.team_id, arg);
        if (!call) return ephemeralNotFound(client, command);
        // The actual pick is collected in a follow-up reply rather than as
        // a command argument, so it isn't limited to a single line pasted
        // after the id. handlers/messages.ts is what actually turns that
        // reply into a recorded prediction.
        await client.chat.postEphemeral({
          channel: call.channelId,
          user: command.user_id,
          text: `What's your call on "${call.question}"? Reply in this thread and I'll record it.`,
          thread_ts: call.threadTs ?? undefined,
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
  });
}

async function ephemeralNotFound(client: App["client"], command: { channel_id: string; user_id: string }) {
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: "Couldn't find that call. Use /calledit mine to see the ids of your calls.",
  });
}
