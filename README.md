# Calledit

A Slack app for recording, sealing and settling predictions. Sibling project to
[Runciter Ledger](https://github.com/miguelangeloazevedo/ledger-slack-app), same VPS,
same pattern. The Slack command is `/calledit` (`/call` is a Slack-reserved built-in
command and can't be registered by a custom app; `/called` was tried too but read
awkwardly as a command, so the app is named to match `/calledit` directly rather than
carry a mismatched name).

## Stack

Node.js, TypeScript, `@slack/bolt` (Socket Mode, OAuth-installable, multi-workspace),
Postgres, Paddle for billing. Process runs under `pm2` as `called`, deployed to
`/opt/called-slack-app` on `srv697704`, alongside Ledger's own `/opt/ledger-slack-app`.
Same Postgres server, separate database (`called`, not `ledger`).

## Local setup

```
npm install
cp .env.example .env   # fill in Slack + Paddle credentials, and DATABASE_URL
npm run migrate        # applies src/db.ts's schema, safe to re-run
npm run dev
```

## Deploy

This is the one thing that went wrong repeatedly on Ledger, so it's written down
explicitly here rather than left to memory.

**Production runs the compiled `dist/` output (`node dist/app.js`), not `src/`
directly.** `git pull` alone updates `src/` and does nothing to `dist/`. Every
deploy is one command, not a chain to remember:

```
ssh root@srv697704 "cd /opt/called-slack-app && git pull && npm run build && npm run migrate && pm2 restart called"
```

Do not deploy by `scp`. On Ledger, `scp -r src root@...` silently failed to
transfer files on more than one occasion, while `pm2` kept restarting the same
stale build with no error, which cost real time to track down. Git pull, on a
box that's already a clone of this repo, is the only deploy path used here.

**Verify, don't assume, after every deploy:**

```
ssh root@srv697704 "pm2 logs called --lines 30 --nostream"
```

A clean startup with no new errors is the bar, not "the command didn't fail." If
something claims to be deployed, check the actual running behaviour (fetch the
install page, run a command in a test workspace) before treating it as done, the
same way a Paddle price claimed to be updated turned out not to be, twice, until an
independent re-check caught it.

## First-time VPS setup (once, not per deploy)

```
ssh root@srv697704
mkdir -p /opt/called-slack-app
cd /opt/called-slack-app
git clone https://github.com/miguelangeloazevedo/called-slack-app.git .
cp .env.example .env   # fill in real values, this file is gitignored and never committed
npm install
npm run build
npm run migrate
pm2 start dist/app.js --name called
pm2 save
```

## Slack app configuration

`manifest.json` in this repo is the source of truth for commands, shortcuts and
scopes, paste it into api.slack.com's manifest editor rather than hand-configuring
each field. After creating the app: enable Socket Mode, generate an app-level
token (`xapp-...`) with `connections:write`, and put it in `.env` as
`SLACK_APP_TOKEN`. The OAuth redirect URL Slack needs is
`https://api.called.runciter.app/slack/oauth_redirect`.

## What's built vs. what's stubbed

Built and working: the full call lifecycle (open, predict, lock, resolve),
Postgres-backed multi-workspace installs, the "I'll enter picks" and "post to
channel" modes from the new-call modal, the reviewer/criteria split, name
resolution via Slack's native user picker, auto-lock on a cron-based poller
(survives restarts, since the deadline lives in Postgres rather than an
in-process timer), the custom OAuth install page, and Paddle entitlement
handling with the verified-install-or-hint reconciliation pattern proven on
Ledger.

Not yet built: the "post to channel" audience actually posting to a specific
list of invited people versus fully open, consequence-pending tracking and
nudges, and the App Home surface (deliberately out of scope per the product
decisions this was built from, everything stays in-channel).

Thread replies are captured as predictions (handlers/messages.ts), this
requires the channels:history / groups:history scopes and the
message.channels / message.groups event subscription, both added after the
first install, so an already-installed workspace needs to reauthorize
(reinstall via the install link) before this actually works there.

## Environment variables

See `.env.example`. Nothing here should ever be pasted into chat or committed;
if a credential does end up in chat history at some point, rotate it rather
than leaving it live.
