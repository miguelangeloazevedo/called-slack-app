import type { App } from "@slack/bolt";
import { buildNewCallModal } from "../modals";

// "Make a prediction" message shortcut: right-click any message to turn its
// text straight into a call's question, skipping the trip through /calledit.
export function registerShortcutHandlers(app: App) {
  app.shortcut("make_a_prediction", async ({ ack, shortcut, client }) => {
    await ack();
    if (shortcut.type !== "message_action") return;

    const view = buildNewCallModal({
      channelId: shortcut.channel.id,
      entryMode: "proxy",
      proxyRowCount: 3,
    });
    // Pre-fill the question with the source message's text; the block
    // structure is identical to the plain /calledit modal from here on.
    const questionBlock = view.blocks.find(
      (b) => "block_id" in b && b.block_id === "question",
    ) as any;
    if (questionBlock) {
      questionBlock.element.initial_value = shortcut.message.text ?? "";
    }

    await client.views.open({ trigger_id: shortcut.trigger_id, view });
  });
}
