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
import { lockNoticeBlocks, openCallsOverviewBlocks } from "../blocks";
import type { Prediction } from "../types";

export function registerCommandHandlers(app: App) {
  app.command("/calledit", async ({ ack, command, client, body }) => {
    await ack();

    const [sub, ...rest] = command.text.trim().split(/\s+/).filter(Boolean);
    const arg = rest.join(" ");

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
          if (!calls.length) {
            await client.chat.postEphemeral({
              channel: command.channel_id,
              user: command.user_id,
              text: "No calls are open in this channel right now.",
            });
            return;
          }
          // One extra query per call for its predictions; fine at the
          // handful-of-open-calls-per-channel scale this runs at.
          const predictionsByCallId = new Map<string, Prediction[]>();
          for (const call of calls) {
            predictionsByCallId.set(call.id, await listPredictions(call.id));
          }
          await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: `${calls.length} call${calls.length === 1 ? "" : "s"} open in this channel`,
            blocks: openCallsOverviewBlocks(calls, predictionsByCallId),
          });
          return;
        }

        case "lock": {
          // arg is "" when no number is given at all, and Number("") is 0
          // (not NaN), so this used to sail straight past the
          // Number.isFinite check in findCallBySeq, query for seq=0 (which
          // never exists), and land on the generic "couldn't find that
          // call" message. That reads like a data problem when it's really
          // a usage problem, catching it here gives the actual answer.
          if (!arg) return ephemeralUsage(client, command, "lock");
          const call = await findCallBySeq(command.team_id, Number(arg));
          if (!call) return ephemeralNotFound(client, command);
          if (call.status !== "open") {
            await client.chat.postEphemeral({
              channel: command.channel_id,
              user: command.user_id,
              text: `#${call.seq} is already *${call.status}*, nothing to lock.`,
            });
            return;
          }
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
          if (!arg) return ephemeralUsage(client, command, "resolve");
          const call = await findCallBySeq(command.team_id, Number(arg));
          if (!call) return ephemeralNotFound(client, command);
          if (call.status === "resolved") {
            await client.chat.postEphemeral({
              channel: command.channel_id,
              user: command.user_id,
              text: `#${call.seq} was already resolved by <@${call.resolvedBy}>: ${call.resultText}`,
            });
            return;
          }
          await client.views.open({
            trigger_id: body.trigger_id,
            view: buildResolveModal(call.id, call.question),
          });
          return;
        }

        case "join": {
          if (!arg) return ephemeralUsage(client, command, "join");
          const call = await findCallBySeq(command.team_id, Number(arg));
          if (!call) return ephemeralNotFound(client, command);
          if (call.status !== "open") {
            // The thread-reply listener (handlers/messages.ts) only
            // records predictions via getCallByThread, which only matches
            // status = 'open'. Without this guard, prompting someone to
            // reply to a locked call told them their reply would be
            // recorded when it silently never would be.
            await client.chat.postEphemeral({
              channel: command.channel_id,
              user: command.user_id,
              text: `#${call.seq} is ${call.status}, predictions are closed. It can no longer accept a call.`,
            });
            return;
          }
          // The actual pick is collected in a follow-up reply rather than
          // as a command argument, so it isn't limited to a single line
          // pasted after the id. handlers/messages.ts is what actually
          // turns that reply into a recorded prediction.
          const sameChannel = call.channelId === command.channel_id;

          // This prompt is deliberately NOT posted with thread_ts, even
          // when it could be. An earlier version threaded it, which is
          // technically correct (the reply does need to land in the
          // thread) but invisible: an ephemeral message posted with
          // thread_ts only renders inside that thread's own pane, not in
          // the main channel view, so it silently looked like the command
          // did nothing at all unless you'd already opened that exact
          // thread. Posting it as a plain top-level ephemeral, with a
          // permalink to the thread, is both visible and still points
          // you to the right place to actually reply.
          let threadLink = "";
          if (sameChannel && call.threadTs) {
            try {
              const permalink = await client.chat.getPermalink({
                channel: call.channelId,
                message_ts: call.threadTs,
              });
              if (permalink.permalink) threadLink = ` <${permalink.permalink}|Open the thread>.`;
            } catch {
              // A permalink is a nice-to-have; the plain-text instruction
              // below is still enough to find the thread without it.
            }
          }

          await client.chat.postEphemeral({
            channel: command.channel_id,
            user: command.user_id,
            text: sameChannel
              ? `What's your call on "${call.question}"? Reply in the thread under the OPEN CALL message and I'll record it.${threadLink}`
              : `What's your call on "${call.question}"? That call is in <#${call.channelId}>, reply in its thread there and I'll record it.`,
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
      // Every subcommand above ends with something visible, a modal, an
      // ephemeral message, a posted card. If one of them throws, this is
      // what stands between that and total silence: a /calledit mine
      // crash on a bad ORDER BY clause once did exactly that, no response,
      // no obvious error, only a stack trace deep in pm2's error log
      // nobody would think to check without a reason to.
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

async function ephemeralUsage(
  client: App["client"],
  command: { channel_id: string; user_id: string },
  sub: "lock" | "resolve" | "join",
) {
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `\`/calledit ${sub}\` needs a call number, e.g. \`/calledit ${sub} 3\`. Run \`/calledit mine\` to see yours.`,
  });
}
