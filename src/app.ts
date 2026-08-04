import "dotenv/config";
import express from "express";
import { App, ExpressReceiver } from "@slack/bolt";
import { pgInstallationStore } from "./installationStore";
import { renderInstallPage } from "./installPage";
import { handlePaddleWebhook } from "./paddleWebhook";
import { registerCommandHandlers } from "./handlers/commands";
import { registerActionHandlers } from "./handlers/actions";
import { registerViewSubmissionHandlers } from "./handlers/viewSubmissions";
import { registerShortcutHandlers } from "./handlers/shortcuts";
import { startReminders } from "./reminders";

const scopes = (process.env.SLACK_SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  clientId: process.env.SLACK_CLIENT_ID!,
  clientSecret: process.env.SLACK_CLIENT_SECRET!,
  stateSecret: process.env.SLACK_STATE_SECRET!,
  scopes,
  installationStore: pgInstallationStore,
  installerOptions: {
    // Built explicitly this time, matching the runciter.app/call branding,
    // rather than left on Bolt's plain library default.
    renderHtmlForInstallPath: (installUrl: string) => renderInstallPage(installUrl),
  },
});

// The Paddle webhook needs the raw request body for HMAC verification, so
// its route is registered directly on the underlying Express app, with
// express.raw() scoped to just this path. Bolt's own routes parse JSON;
// mixing that with a route that needs the untouched raw bytes is a known
// footgun if the raw-body middleware isn't applied narrowly like this.
receiver.router.post(
  "/paddle/webhook",
  express.raw({ type: "application/json" }),
  handlePaddleWebhook,
);

const app = new App({
  receiver,
  token: undefined, // multi-workspace: token is resolved per-request via installationStore
});

registerCommandHandlers(app);
registerActionHandlers(app);
registerViewSubmissionHandlers(app);
registerShortcutHandlers(app);

(async () => {
  const port = Number(process.env.PORT ?? 3300);
  await app.start(port);
  startReminders(app);
  console.log(`⚡️ Called is running on port ${port} (OAuth-installable).`);
})().catch((err) => {
  console.error("Failed to start Called", err);
  process.exit(1);
});
