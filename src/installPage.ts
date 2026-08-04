// Custom OAuth install page. Deliberately built to the same structure and
// CSS as Ledger's (see ledger-slack-app/src/installPage.ts): bordered card,
// "Runciter // <app>" label, numbered steps, fine-print line with About/
// Privacy links, same dark/monospace palette. The two apps share a VPS and
// a site, this page is often the first thing someone sees after clicking
// "Add to Slack" on either one, and it used to look nothing alike, a plain
// centered card with an SVG mark instead of Ledger's bordered layout.
export function renderInstallPage(installUrl: string): string {
  // Slack's InstallProvider builds this URL itself from clientId/scopes/
  // state, so it's not user input, still escaped defensively before going
  // into an href attribute.
  const safeUrl = installUrl.replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Add Calledit to Slack</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #14161a;
    color: #f5f5f0;
    font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
    padding: 24px;
  }
  .card {
    max-width: 420px;
    width: 100%;
    border: 1px solid #f5f5f0;
    padding: 32px;
  }
  .label {
    font-size: 11px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: #888;
    margin: 0 0 16px;
  }
  h1 {
    font-size: 22px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    margin: 0 0 12px;
  }
  p {
    font-size: 14px;
    line-height: 1.6;
    color: #b8b8b0;
    margin: 0 0 24px;
  }
  .rule {
    border: none;
    border-top: 1px dashed #444;
    margin: 24px 0;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    background: #f5f5f0;
    color: #14161a;
    text-decoration: none;
    padding: 14px 22px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border: 1px solid #f5f5f0;
    transition: background 0.15s, color 0.15s;
  }
  .btn:hover { background: #14161a; color: #f5f5f0; }
  .steps { margin: 0; padding: 0; list-style: none; }
  .steps li {
    font-size: 12px;
    color: #888;
    padding: 6px 0;
    display: flex;
    gap: 10px;
  }
  .steps li span { color: #555; }
  .fine {
    margin-top: 24px;
    font-size: 11px;
    color: #666;
    line-height: 1.6;
  }
  .fine a { color: #999; }
</style>
</head>
<body>
  <div class="card">
    <p class="label">Runciter // Calledit</p>
    <h1>Add Calledit to Slack</h1>
    <p>Turn a Slack question into a locked prediction. Ask, set a deadline, and Calledit posts who called it once it settles.</p>

    <a class="btn" href="${safeUrl}">Add to Slack &nbsp;&rarr;</a>

    <hr class="rule">

    <ul class="steps">
      <li><span>01</span> Approve the OAuth screen (a workspace admin may need to)</li>
      <li><span>02</span> Invite the bot to a channel: <code>/invite @Calledit</code></li>
      <li><span>03</span> Type <code>/calledit</code>, or right-click a message &rarr; Make a prediction</li>
    </ul>

    <p class="fine">First month free for the whole workspace, then a flat monthly or yearly price — no per-seat billing.
      <a href="https://runciter.app/call">About Calledit</a> &middot;
      <a href="https://runciter.app/call/privacy">Privacy</a>
    </p>
  </div>
</body>
</html>`;
}
