import type { App } from "@slack/bolt";
import {
  createCall,
  listAuditEvents,
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
      showReviewer: boolean;
      showCriteria: boolean;
    };
    const values = view.state.values;
    const creatorId = body.user.id;

    const question = values.question?.value?.value?.trim();
    // Criteria is optional now, revealed via the "+ Add acceptance
    // criteria" button rather than a field shown up front (see modals.ts).
    const criteria = values.criteria?.value?.value?.trim();
    // The deadline picker is a date-only `datepicker`, not a
    // `datetimepicker`, living in the "closing_row" actions block
    // alongside the optional "+ Add acceptance criteria" button, so it
    // reads back as selected_date (a "YYYY-MM-DD" string), not a unix
    // timestamp. Every call closes at 17:00 on whatever date is picked,
    // there is no time-of-day control in this modal.
    const closesAtDate = values.closing_row?.closes_at?.selected_date;
    const visibility = (values.visibility?.value?.selected_option?.value ?? "sealed_until_close") as Visibility;
    const winnings = values.winnings?.value?.value?.trim() || "Bragging rights";
    const reviewerId = values.reviewer?.value?.selected_user || creatorId;

    // Note: Slack only renders inline field errors (response_action:
    // "errors") against "input" blocks. closing_row is an "actions" block
    // (needed for the side-by-side layout), so a missing date here would
    // not show a nice red message the way a missing question does. The
    // datepicker ships with a default a week out (see defaultCloseDate in
    // modals.ts) specifically to make that gap rarely matter in practice.
    const errors: Record<string, string> = {};
    if (!question) errors.question = "This can't be blank.";
    if (!closesAtDate) errors.closing_row = "Pick when predictions close.";

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

    // Every call closes at 17:00 UTC on the picked date; there is no
    // workspace-timezone lookup here, this is a fixed convention rather
    // than a per-team setting.
    const closesAt = new Date(`${closesAtDate}T17:00:00Z`);

    const call = await createCall({
      workspaceId: body.team?.id ?? body.user.team_id ?? "",
      channelId: meta.channelId,
      question: question!,
      criteria: criteria || null,
      creatorId,
      reviewerId,
      entryMode: meta.entryMode,
      visibility,
      winnings,
      closesAt,
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
      const [predictions, auditEvents] = await Promise.all([
        listPredictions(call.id),
        listAuditEvents(call.id),
      ]);
      await client.chat.postMessage({
        channel: call.channelId,
        thread_ts: call.threadTs,
        blocks: settleBlocks(call, predictions, auditEvents),
        text: `Result: ${resultText}`,
      });
    }
  });
}
