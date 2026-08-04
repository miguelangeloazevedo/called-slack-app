import type { App } from "@slack/bolt";
import { buildNewCallModal, nextProxyRowCount } from "../modals";
import { getCall, recordAuditEvent } from "../db";

interface NewCallPrivateMetadata {
  channelId: string;
  entryMode: "proxy" | "channel";
  proxyRowCount: number;
}

export function registerActionHandlers(app: App) {
  // Entry-mode toggle buttons re-render the modal in place via views.update,
  // since Slack has no conditional-visibility block primitive.
  app.action("entry_mode_proxy", async ({ ack, body, client }) =>
    switchEntryMode(ack, body, client, "proxy"),
  );
  app.action("entry_mode_channel", async ({ ack, body, client }) =>
    switchEntryMode(ack, body, client, "channel"),
  );

  app.action("add_proxy_row", async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions" || !body.view) return;
    const meta = JSON.parse(body.view.private_metadata) as NewCallPrivateMetadata;
    await client.views.update({
      view_id: body.view.id,
      hash: body.view.hash,
      view: buildNewCallModal({
        channelId: meta.channelId,
        entryMode: meta.entryMode,
        proxyRowCount: nextProxyRowCount(meta.proxyRowCount),
      }),
    });
  });

  // "Make your call" button on a channel-mode open card. Kept as a light
  // prompt-to-DM rather than a full modal, since the whole point of channel
  // mode is a free-text answer with no structure to fill in.
  app.action("call_join", async ({ ack, body, client }) => {
    await ack();
    if (body.type !== "block_actions") return;
    const callId = body.actions[0]?.type === "button" ? body.actions[0].value : undefined;
    if (!callId) return;
    const call = await getCall(callId);
    if (!call) return;

    await client.chat.postEphemeral({
      channel: call.channelId,
      user: body.user.id,
      thread_ts: call.threadTs ?? undefined,
      text: `What's your call on "${call.question}"? Reply in this thread and it'll be recorded.`,
    });
    await recordAuditEvent(call.id, body.user.id, "joined", "via button");
  });
}

async function switchEntryMode(
  ack: () => Promise<void>,
  // Bolt's block_actions body type is awkward to name pointwise here;
  // narrowed with the `body.type !== "block_actions"` guard below instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  client: App["client"],
  entryMode: "proxy" | "channel",
) {
  await ack();
  if (body.type !== "block_actions" || !body.view) return;
  const meta = JSON.parse(body.view.private_metadata) as NewCallPrivateMetadata;
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: buildNewCallModal({
      channelId: meta.channelId,
      entryMode,
      proxyRowCount: meta.proxyRowCount,
    }),
  });
}
