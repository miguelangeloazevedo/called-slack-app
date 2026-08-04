// Custom OAuth install page, matching the runciter.app/call branding
// (dark background, monospace, the bell mark). Built up front this time --
// on Ledger this was left on Bolt's plain library default for a long
// stretch simply because nobody wired up `renderHtmlForInstallPath`.
export function renderInstallPage(installUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Install Called</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0a;
    color: #f2f2f2;
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .card { max-width: 30rem; padding: 2.5rem; text-align: center; }
  .mark { width: 44px; height: 44px; margin: 0 auto 1.5rem; }
  h1 { font-size: 1.5rem; letter-spacing: 0.15em; text-transform: uppercase; margin: 0 0 0.75rem; }
  p { font-size: 0.9rem; line-height: 1.6; color: #b3b3b3; margin: 0 0 2rem; }
  ol { text-align: left; font-size: 0.8rem; color: #b3b3b3; line-height: 1.9; padding-left: 1.2rem; margin: 0 0 2rem; }
  a.btn {
    display: inline-block;
    padding: 0.75rem 1.5rem;
    background: #f2f2f2;
    color: #0a0a0a;
    text-decoration: none;
    font-size: 0.85rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 500;
  }
  a.btn:hover { opacity: 0.85; }
</style>
</head>
<body>
  <div class="card">
    <svg class="mark" viewBox="0 0 64 64" fill="none" stroke="#f2f2f2" stroke-width="3" stroke-linecap="square" stroke-linejoin="miter">
      <path d="M24 38 L28 14 H36 L40 38 Z"/>
      <path d="M18 38 H46"/>
      <circle cx="32" cy="47" r="3"/>
      <path d="M48 20 L55 16 M48 26 L56 26"/>
      <path d="M16 20 L9 16 M16 26 L8 26"/>
    </svg>
    <h1>Install Called</h1>
    <p>Record, seal and settle predictions in Slack. One flat price per workspace, first month free.</p>
    <ol>
      <li>Approve the permissions on the next screen.</li>
      <li>Invite the bot to any channel: <code>/invite @Called</code></li>
      <li>Make your first call: <code>/call</code></li>
    </ol>
    <a class="btn" href="${installUrl}">Add to Slack</a>
  </div>
</body>
</html>`;
}
