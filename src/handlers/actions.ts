import type { App } from "@slack/bolt";
import { buildNewCallModal, nextProxyRowCount } from "../modals";
import { getCall, hasAccess, recordAuditEvent, trialEndedMessage } from "../db";

interface NewCallPrivateMetadata {
  channelId: string;
  entryMode: "proxy" | "channel";
  proxyRowCount: number;
  showReviewer: boolean;
  showCriteria: boolean;
}

export function registerActionHandlers(app: App) {
  // Entry-mode toggle buttons, add-person, add-reviewer and add-criteria all
  // re-render the modal in place via views.update, since Slack has no
  // conditional-visibility block primitive.
  app.action("entry_mode_proxy", async ({ ack, body, client }) =>
    rerenderModal(ack, body, client, { entryMode: "proxy" }),
  );
  app.action("entry_mode_channel", async ({ ack, body, client }) =>
    rerenderModal(ack, body, client, { entryMode: "channel" }),
  );

  app.action("add_proxy_row", async ({ ack, body, client }) => {
    if (body.type !== "block_actions" || !body.view) {
      await ack();
      return;
    }
    const meta = JSON.parse(body.view.private_metadata) as NewCallPrivateMetadata;
    await rerenderModal(ack, body, client, {
      proxyRowCount: nextProxyRowCount(meta.proxyRowCount),
    });
  });

  app.action("add_reviewer", async ({ ack, body, client }) =>
    rerenderModal(ack, body, client, { showReviewer: true }),
  );

  app.action("add_criteria", async ({ ack, body, client }) =>
    rerenderModal(ack, body, client, { showCriteria: true }),
  );

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

    if (!(await hasAccess(call.workspaceId))) {
      await client.chat.postEphemeral({
        channel: call.channelId,
        user: body.user.id,
        text: trialEndedMessage(call.workspaceId),
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: call.channelId,
      user: body.user.id,
      thread_ts: call.threadTs ?? undefined,
      text: `What's your call on "${call.question}"? Reply in this thread and it'll be recorded.`,
    });
    await recordAuditEvent(call.id, body.user.id, "joined", "via button");
  });
}

// Shared re-render helper: reads the current modal's state out of
// private_metadata, applies a partial patch, and rebuilds the view. Every
// button in the new-call modal (entry mode, add person, add reviewer, add
// criteria) is just a different patch through this same path.
async function rerenderModal(
  ack: () => Promise<void>,
  // Bolt's block_actions body type is awkward to name pointwise here;
  // narrowed with the `body.type !== "block_actions"` guard below instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  client: App["client"],
  patch: Partial<NewCallPrivateMetadata>,
) {
  await ack();
  if (body.type !== "block_actions" || !body.view) return;
  const meta = JSON.parse(body.view.private_metadata) as NewCallPrivateMetadata;
  const next = { ...meta, ...patch };
  await client.views.update({
    view_id: body.view.id,
    hash: body.view.hash,
    view: buildNewCallModal(next),
  });
}
