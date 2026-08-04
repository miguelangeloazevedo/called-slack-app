import "dotenv/config";
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
const port = Number(process.env.PORT ?? 3300);

// Socket Mode, matching Ledger and the manifest (socket_mode_enabled: true).
// An earlier version of this file used a plain ExpressReceiver instead,
// which meant Calledit had an HTTP server but was never actually connected
// to Slack over the socket, so commands and interactivity silently never
// arrived.
//
// A second, later version of this file assumed SocketModeReceiver exposed
// an Express app at `receiver.app`, the way ExpressReceiver does, and cast
// past the type checker to reach it. That was wrong and crashed on boot
// ("Cannot read properties of undefined (reading 'post')"): checked against
// the installed @slack/bolt source directly, SocketModeReceiver is not built
// on Express at all. It runs its own bare `http.createServer` internally,
// used only for the OAuth install/redirect paths and for whatever routes
// are passed in via `customRoutes` below, and `this.app` on that class is
// actually the Bolt `App` instance itself (set later via `.init()`), not an
// Express app. Extra HTTP routes have to be declared up front as
// `customRoutes`; their handlers get Node's raw req/res, not Express's.
//
// Also worth knowing: `app.start(port)` does NOT forward `port` to
// SocketModeReceiver, its `start()` takes no arguments and always listens on
// `installerOptions.port` (default 3000). PORT from .env only takes effect
// because it's threaded through explicitly below.
const receiver = new SocketModeReceiver({
  appToken: process.env.SLACK_APP_TOKEN!,
  clientId: process.env.SLACK_CLIENT_ID!,
  clientSecret: process.env.SLACK_CLIENT_SECRET!,
  stateSecret: process.env.SLACK_STATE_SECRET!,
  scopes,
  installationStore: pgInstallationStore,
  installerOptions: {
    port,
    // Built explicitly this time, matching the runciter.app/call branding,
    // rather than left on Bolt's plain library default.
    renderHtmlForInstallPath: (installUrl: string) => renderInstallPage(installUrl),
  },
  // The Paddle webhook needs the exact raw request body for HMAC
  // verification. handlePaddleWebhook reads it straight off the Node
  // request stream itself, see paddleWebhook.ts, since there is no
  // Express (and so no express.raw()) in this receiver.
  customRoutes: [
    {
      path: "/paddle/webhook",
      method: "POST",
      handler: handlePaddleWebhook,
    },
  ],
});

const app = new App({
  receiver,
  token: undefined, // multi-workspace: token is resolved per-request via installationStore
});

registerCommandHandlers(app);
registerActionHandlers(app);
registerViewSubmissionHandlers(app);
registerShortcutHandlers(app);

(async () => {
  // Port is already wired in via installerOptions.port above; app.start()
  // takes no arguments for SocketModeReceiver.
  await app.start();
  startReminders(app);
  console.log(`⚡️ Calledit is running on port ${port} (OAuth-installable).`);
})().catch((err) => {
  console.error("Failed to start Calledit", err);
  process.exit(1);
});
