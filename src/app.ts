import "dotenv/config";
import express from "express";
import { App, SocketModeReceiver } from "@slack/bolt";
import { pgInstallationStore } from "./installationStore";
import { renderInstallPage } from "./installPage";
import { handlePaddleWebhook } from "./paddleWebhook";
import { registerCommandHandlers } from "./handlers/commands";
import { registerActionHandlers } from "./handlers/actions";
import { registerViewSubmissionHandlers } from "./handlers/viewSubmissions";
import { registerShortcutHandlers } from "./handlers/shortcuts";
import { startReminders } from "./reminders";

const scopes = (process.env.SLACK_SCOPES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// Socket Mode, matching Ledger and the manifest (socket_mode_enabled: true).
// An earlier version of this file used a plain ExpressReceiver instead,
// which meant Calledit had an HTTP server but was never actually connected
// to Slack over the socket, so commands and interactivity silently never
// arrived. SocketModeReceiver still runs a small internal Express app for
// the OAuth install/redirect endpoints (exposed as `receiver.app`, used
// below for the Paddle webhook route); everything else, commands, actions,
// view submissions, comes over the WebSocket connection instead of HTTP.
const receiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN!,
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
// its route is registered directly on the receiver's underlying Express
// app, with express.raw() scoped to just this path. Bolt's own OAuth
// routes parse JSON; mixing that with a route that needs the untouched raw
// bytes is a known footgun if the raw-body middleware isn't applied this
// narrowly.
//
// `receiver.app` genuinely exists at runtime, it's how SocketModeReceiver
// wires up its own install/oauth_redirect routes, it's just typed private
// in @slack/bolt's declarations rather than exposed as public API. Cast
// past the compiler check rather than standing up a second HTTP server on
// a different port, which would need its own reverse-proxy entry I can't
// configure from here. Re-check this line if @slack/bolt is ever upgraded.
(receiver as unknown as { app: express.Express }).app.post(
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
  console.log(`⚡️ Calledit is running on port ${port} (OAuth-installable).`);
})().catch((err) => {
  console.error("Failed to start Calledit", err);
  process.exit(1);
});
