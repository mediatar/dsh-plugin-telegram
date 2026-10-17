# Changelog

## 0.1.0 — 2026-10-18

First working release.

### Features

- Host-side Cordis plugin: drives DSH sessions from a Telegram bot.
- `/projects`, `/sessions`, `/new`, `/use`, `/status`, `/rename`, `/cancel`
  (`/stop` alias), `/follow`, `/start`, `/help`; free text is delivered as a prompt.
- Inline keyboards mirroring the project and session lists.
- Assistant output streamed back into the chat as one growing, throttled message.
- `/follow` mirrors whichever session is active in the DSH UI
  (`api-session/activity` / `api-session/status`).
- Bot API client with `http://`, `https://` and `socks5://` proxy tunnels
  (optional credentials), bounded retries and 429 handling.

### Packaging

- Zero npm dependencies: Node built-ins only.
- Self-contained Standard Schema config (Schemastery-compatible metadata) so the
  package works from a `link:` install, where host packages are not resolvable.
- Fully projected config schema: `dsh --profile <p> --dump-config-schema` reports
  `status: "schema"` with no diagnostics.
- Operator-facing diagnostics go to stderr as well as `ctx.logger`, because the
  `dsh` CLI does not render Cordis log output.

### Verification

- 94 unit/e2e tests against a local mock Bot API.
- Real-Host probes: 13/13 host checks, 7/7 streaming checks, 5/5 profile-patch
  configuration checks.
