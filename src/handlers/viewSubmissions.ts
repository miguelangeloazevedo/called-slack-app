import type { App } from "@slack/bolt";
import {
  createCall,
  listPredictions,
  recordAuditEvent,
  resolveCall,
  setCallThread,
  upsertPrediction,
} from "../db";
import { NEW_CALL_CALLBACK_ID, RESOLVE_CALLBACK_ID } from "../modals";
import { openCallBlocks, settleBlocks } from "../blocks";
import type { EntryMode, Visibility } from "../types";

export function registerViewSubmissionHandlers(app: App) {
  app.view(NEW_CALL_CALLBACK_ID, async ({ ack, view, body, client }) => {
    const meta = JSON.parse(view.private_metadata) as {
      channelId: string;
      entryMode: EntryMode;
      proxyRowCount: number;
    };
    const values = view.state.values;
    const creatorId = body.user.id;

    const question = values.question?.value?.value?.trim();
    const criteria = values.criteria?.value?.value?.trim();
    const closesAtIso = values.closes_at?.value?.selected_date_time;
    const visibility = (values.visibility?.value?.selected_option?.value ?? "sealed_until_close") as Visibility;
    const winnings = values.winnings?.value?.value?.trim() || "Bragging rights";
    const reviewerId = values.reviewer?.value?.selected_user || creatorId;

    const errors: Record<string, string> = {};
    if (!question) errors.question = "This can't be blank.";
    if (!criteria) errors.criteria = "How will this be settled?";
    if (!closesAtIso) errors.closes_at = "Pick when predictions close.";

    if (meta.entryMode === "proxy") {
      const anyRow = Array.from({ length: meta.proxyRowCount }).some(
        (_, i) => values[`proxy_person_${i}`]?.value?.selected_user,
      );
      if (!anyRow) errors.proxy_person_0 = "Add at least one person and their call.";
    }

    if (Object.keys(errors).length > 0) {
      await ack({ response_action: "errors", errors });
      return;
    }

    await ack();

    const call = await createCall({
      workspaceId: body.team?.id ?? body.user.team_id ?? "",
      channelId: meta.channelId,
      question: question!,
      criteria: criteria!,
      creatorId,
      reviewerId,
      entryMode: meta.entryMode,
      visibility,
      winnings,
      closesAt: new Date(closesAtIso! * 1000),
    });
    await recordAuditEvent(call.id, creatorId, "created");

    // Proxy-entered picks land immediately; channel-mode calls start with
    // nobody predicted, waiting for replies.
    if (meta.entryMode === "proxy") {
      for (let i = 0; i < meta.proxyRowCount; i++) {
        const userId = values[`proxy_person_${i}`]?.value?.selected_user;
        const pick = values[`proxy_value_${i}`]?.value?.value?.trim();
        if (userId && pick) {
          await upsertPrediction(call.id, userId, pick);
          await recordAuditEvent(call.id, creatorId, "predicted", `entered for <@${userId}>`);
        }
      }
    }

    const posted = await client.chat.postMessage({
      channel: meta.channelId,
      blocks: openCallBlocks(call),
      text: `New call: ${call.question}`,
    });
    if (posted.ts) {
      await setCallThread(call.id, posted.ts);
    }
  });

  app.view(RESOLVE_CALLBACK_ID, async ({ ack, view, body, client }) => {
    await ack();
    const meta = JSON.parse(view.private_metadata) as { callId: string };
    const values = view.state.values;
    const resultText = values.result?.value?.value?.trim() ?? "";
    const evidenceText = values.evidence?.value?.value?.trim() ?? "";

    const call = await resolveCall(meta.callId, {
      resultText,
      evidenceText,
      resolvedBy: body.user.id,
    });
    await recordAuditEvent(call.id, body.user.id, "resolved", resultText);

    if (call.threadTs) {
      const predictions = await listPredictions(call.id);
      await client.chat.postMessage({
        channel: call.channelId,
        thread_ts: call.threadTs,
        blocks: settleBlocks(call, predictions),
        text: `Result: ${resultText}`,
      });
    }
  });
}
