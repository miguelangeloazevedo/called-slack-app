import cron from "node-cron";
import type { App } from "@slack/bolt";
import { listCallsPastDeadline, listPredictions, lockCall, recordAuditEvent } from "./db";
import { lockNoticeBlocks } from "./blocks";

// Auto-lock is state stored in Postgres, checked on a schedule, not an
// in-memory timer per call. A timer tied to process lifetime would silently
// stop working across every pm2 restart or redeploy; this survives both,
// since the source of truth (closes_at) lives in the database, not in RAM.
export function startReminders(app: App) {
  cron.schedule("* * * * *", async () => {
    let due;
    try {
      due = await listCallsPastDeadline();
    } catch (err) {
      console.error("[reminders] failed to query due calls", err);
      return;
    }

    for (const call of due) {
      try {
        await lockCall(call.id);
        await recordAuditEvent(call.id, null, "locked", "auto-lock at deadline");
        if (call.threadTs) {
          const predictions = await listPredictions(call.id);
          await app.client.chat.postMessage({
            channel: call.channelId,
            thread_ts: call.threadTs,
            blocks: lockNoticeBlocks(call, predictions),
            text: "Call locked.",
          });
        }
      } catch (err) {
        // One call failing to lock shouldn't stop the rest of the batch;
        // it'll be picked up again on the next tick since its status is
        // still "open" until the update above actually succeeds.
        console.error(`[reminders] failed to lock call ${call.id}`, err);
      }
    }
  });
}
