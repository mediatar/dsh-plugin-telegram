# dsh-plugin-telegram

Drive DeepSeek Harness (DSH) sessions from a Telegram bot: list projects, list and
create sessions, send prompts, cancel a running turn, rename a session, and read
the assistant's reply in the chat as it is produced.

The plugin is **Host-side**. It runs inside the DSH Host process next to the
session and workspace services, so it works in any profile that composes the Web
Host — DSH Desktop, `dsh web`, or a custom profile built on `@deepseek-ai/dsh-base`
plus a Host surface. No client (browser) bundle is involved.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Configure](#configure)
- [Blocked networks and the `proxy` setting](#blocked-networks-and-the-proxy-setting)
- [Commands](#commands)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Requirements

| Requirement | Notes |
| --- | --- |
| DSH Desktop, or any profile composing the Web Host | The plugin needs `sessionController`, `workspaceRegistry` and `sessions` on the Host. |
| Node.js >= 22 | The Host itself provides Node; you only need it on `PATH` if you run the test suite. |
| A Telegram bot token | Create one with [@BotFather](https://t.me/BotFather) (`/newbot`). It looks like `123456789:AAH...`. |
| Outbound HTTPS to `api.telegram.org` | Directly, or through the [`proxy`](#blocked-networks-and-the-proxy-setting) setting. |

The plugin has **no npm dependencies**. It uses only Node built-ins
(`node:https`, `node:tls`, `node:net`, `node:crypto`), so installing it adds no
packages to your profile beyond the plugin itself.

---

## Install

There are two supported paths. Both end with the same state: the package is a
dependency of the profile, and the profile composition contains one row named
`telegram-bot`.

> **Quit DSH Desktop before installing.** The bundled CLI takes a lock on the
> profile's `package.json`; while Desktop is running it can hold that lock and
> the install waits (up to two minutes) and then fails. Quit Desktop fully, run
> the install, then start Desktop again.

### Option A — the bundled CLI (recommended)

The Desktop installation ships a `dsh` command that can manage its own
`desktop` profile. From a PowerShell window:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:C:\Users\Mediatar\Documents\deepseek-harness\default-workspace\plugin\dsh-plugin-telegram"
```

Replace the path with the absolute path of your copy of this directory. The
`link:` prefix installs the directory in place (a symlink) instead of copying it,
so edits to the plugin take effect without reinstalling.

The same thing through the bundled script, which finds the CLI for you and
supports `-DryRun`:

```powershell
pwsh -NoProfile -File .\plugin\dsh-plugin-telegram\scripts\install.ps1 -DryRun
pwsh -NoProfile -File .\plugin\dsh-plugin-telegram\scripts\install.ps1
```

Use `-Profile <name>` to target a profile other than `desktop`:

```powershell
pwsh -NoProfile -File .\plugin\dsh-plugin-telegram\scripts\install.ps1 -Profile web
```

### Option B — manual

1. Add the package to the profile's dependencies in
   `C:\Users\Mediatar\.dsh\profiles\desktop\package.json`:

   ```json
   {
     "dependencies": {
       "dsh-plugin-telegram": "link:C:/Users/Mediatar/Documents/deepseek-harness/default-workspace/plugin/dsh-plugin-telegram"
     }
   }
   ```

2. Select the bundle in the same file. A package that declares
   `dsh.bundle.patch` contributes its rows **only while it is listed in
   `dsh.profile.bundles`**:

   ```json
   {
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-plugin-telegram"
         ]
       }
     }
   }
   ```

3. Install the dependency in the profile directory:

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop install
   ```

   (`dsh plugin` forwards its arguments to pnpm in the profile directory, so any
   pnpm command works, e.g. `dsh plugin --profile desktop why dsh-plugin-telegram`.)

### How the row gets into the composition

`package.json` in this plugin declares `dsh.bundle.patch: ./cordis.patch.yml`, and
that file inserts exactly one row:

```yaml
- insert:
    - id: telegram-bot
      name: dsh-plugin-telegram
```

Two consequences worth knowing:

- **The bundle must be selected.** Installing the package is not enough; it has
  to appear in `dsh.profile.bundles`. The CLI path does this for you when it adds
  a package that declares a bundle patch. For a manual install you add the name
  yourself (step 2).
- **A profile patch row is the alternative.** If you would rather not select the
  bundle, insert the row from the profile's own `cordis.patch.yml` instead:

  ```yaml
  - insert:
      - id: telegram-bot
        name: dsh-plugin-telegram
        config:
          token: "123456:ABC..."
          allowedUsers: [123456789]
  ```

  This is also where the `config:` block goes if you prefer configuration over
  environment variables. Define the row in exactly one place. The Loader keys
  entries by id, so two `insert` rows with id `telegram-bot` collapse into a
  single entry and the later definition wins — you get one bot with a config you
  may not have intended, not two bots.

### Verify the row is composed

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop list
```

`dsh-plugin-telegram` should appear in the dependency list.

**Inspecting the composed row.** `--dump-config` is refused for the `desktop`
profile — that name is reserved for the Electron application, so
`dsh --profile desktop --dump-config` fails with
`error: profile "desktop" is managed exclusively by the Electron application`.
`--dump-config` shows the tree of the profile you name, so it cannot show
Desktop's tree. On Desktop, confirm the row through **Settings → Plugins**, or
check that the package is both a dependency and an entry in
`dsh.profile.bundles`.

On any other profile you can see the row directly. If you installed into `web`,
for example:

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --dump-config
```

The output then contains:

```yaml
# == dsh-plugin-telegram
- id: telegram-bot
  name: dsh-plugin-telegram
```

Seeing that pair is the proof the bundle was selected and its patch was applied.
(Note that `dsh` auto-initializes a shipped profile such as `web` on first use, so
running this creates `~/.dsh/profiles/web` if it did not exist.)

---

## Configure

Configuration is validated against a schema. **Unknown keys are rejected**, so a
typo such as `alowedUsers` fails loudly at startup instead of silently leaving the
bot open to everyone.

Put values in the `config:` block of the row (profile `cordis.patch.yml`), or use
the environment variable where one exists. A non-empty `config` value wins over
the environment variable.

| Option | Type | Default | Environment fallback | Meaning |
| --- | --- | --- | --- | --- |
| `token` | string | *none* | `DSH_TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. With no token the plugin logs one line and never touches the network. |
| `allowedUsers` | number[] | `[]` | `DSH_TELEGRAM_ALLOWED_USERS` (comma- or space-separated) | Telegram numeric user ids allowed to drive the bot. `[]` means **anyone** — see [Security](#security). Config and environment values are merged. |
| `proxy` | string | *none* (direct) | `DSH_TELEGRAM_PROXY` | Proxy for Bot API calls: `http://host:port`, `https://host:port`, `socks5://user:pass@host:port`. See [Blocked networks](#blocked-networks-and-the-proxy-setting). |
| `baseUrl` | string | `https://api.telegram.org` | `DSH_TELEGRAM_BASE_URL` | Bot API origin. Change only for a self-hosted Bot API server or a test double. |
| `pollTimeoutSeconds` | integer 0–50 | `25` | — | Long-poll timeout passed to `getUpdates`. `0` makes polling non-blocking. |
| `requestTimeoutMs` | integer 1000–600000 | `60000` | — | Per-request Bot API timeout. Must exceed `pollTimeoutSeconds` by a margin, or long polls abort. |
| `stream` | boolean | `true` | — | Mirror assistant output into the chat while a turn runs. `false` disables live replies. |
| `notifyTools` | boolean | `false` | — | Show the currently running tool inside the streamed reply. |
| `markdown` | boolean | `true` | — | Render replies with Telegram `Markdown`. Set to `false` if your agent output contains unbalanced `*`/`_`. |

Example profile patch (`~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: telegram-bot
      name: dsh-plugin-telegram
      config:
        token: "123456789:AAH..."
        allowedUsers: [123456789]
        proxy: "socks5://127.0.0.1:1080"
        pollTimeoutSeconds: 25
        requestTimeoutMs: 60000
        stream: true
        notifyTools: false
```

### Find your Telegram user id

Send any message to the bot before configuring `allowedUsers`: the bot answers
`⛔ Not authorized.` and prints your numeric id. Put that number in
`allowedUsers` and restart.

### Applying a configuration change

Edit the profile patch, then restart DSH. With the `hmr` entry enabled, a profile
patch change is recomposed in place; without it the change applies on the next
start. Either way, a token change starts a new poller, so the old one stops
first.

---

## Blocked networks and the `proxy` setting

**`api.telegram.org` is not reachable from many networks**, including some
Russian ISPs, where TCP 443 to Telegram's `149.154.160.0/20` and
`91.108.4.0/22` ranges is blackholed. This is a network-level block, not a plugin
bug: on such a network the connection attempt hangs until it times out instead of
being refused.

If the bot does not start and the log shows something like

```text
telegram-bot: getMe failed — bot not started: POST transport failed: The operation was aborted
```

then the Host cannot reach the Bot API. The `POST transport failed: ...` tail is
the underlying socket error; on a blackholed route it typically reads
`The operation was aborted` (the request hit `requestTimeoutMs`),
`connect ETIMEDOUT`, or `getaddrinfo ENOTFOUND api.telegram.org`. Fix it by
pointing the plugin at a proxy you already run locally:

```yaml
- insert:
    - id: telegram-bot
      name: dsh-plugin-telegram
      config:
        token: "123456789:AAH..."
        allowedUsers: [123456789]
        proxy: "socks5://127.0.0.1:1080"
```

or with an environment variable:

```powershell
$env:DSH_TELEGRAM_PROXY = "socks5://127.0.0.1:1080"
```

Concrete forms the client accepts:

| `proxy` value | Use it when |
| --- | --- |
| `socks5://127.0.0.1:1080` | You run a local SOCKS5 endpoint (the usual port for a desktop proxy client's SOCKS listener). |
| `socks5h://127.0.0.1:1080` | Same, and you want the hostname resolved by the proxy rather than locally. |
| `socks5://user:pass@127.0.0.1:1080` | Your SOCKS5 endpoint requires username/password authentication. |
| `http://127.0.0.1:8080` | You run a local HTTP proxy; the client opens a `CONNECT` tunnel through it. |
| `http://user:pass@127.0.0.1:8080` | The HTTP proxy requires Basic authentication. |

Notes:

- The plugin does not ship, recommend or configure any particular proxy product.
  Use whatever you already have; the table above only names the URL forms.
- Every proxied request is tunnelled (`CONNECT` for HTTP proxies, SOCKS5 for
  SOCKS), so TLS to `api.telegram.org` is still end-to-end and proxy credentials
  never appear in a forwarded request line.
- A malformed value fails at startup with a clear message, e.g.
  `unsupported proxy scheme "ftp:" (use http://, https:// or socks5://)` or
  `invalid proxy URL: ...`.
- `DSH_TELEGRAM_PROXY` is read once at startup. Restart DSH after changing it.

### Checking reachability before blaming the plugin

```powershell
Test-NetConnection api.telegram.org -Port 443
```

A blackholed network shows `TcpTestSucceeded : False` after a long wait. If it
hangs rather than failing, the route is being dropped silently — that is exactly
the case the `proxy` setting exists for.

---

## Commands

Send these to the bot in a private chat or a group. Commands also appear in
Telegram's `/` menu, which the plugin registers on startup.

| Command | What it does |
| --- | --- |
| `/start`, `/help` | Show the control panel: which project and session are selected, the Host name, and the command list. |
| `/projects` | List projects (DSH workspaces) with a session count and inline buttons. Tapping a button selects that project and immediately lists its sessions. |
| `/p <ref>` | Select a project directly: a list number, a workspace id, an exact title, or a path. |
| `/sessions` | List the current project's sessions (up to 25) with age and a running marker, plus inline buttons. |
| `/new` | Create a session in the current project and select it. |
| `/use <n\|id>` | Switch to a session by list number (from the last `/sessions` output), full id, or id prefix. |
| `/follow [off]` | Follow whichever session is active in the DSH UI: when you work in another session in DSH, this chat starts mirroring it. `/follow off` stops. |
| `/status` | Show the selected project, session, full session id, running state and Host name, with buttons for projects, sessions and stop. |
| `/rename <title>` | Rename the current session. |
| `/cancel` | Ask the Host to stop the running turn. `/stop` is an alias. |
| *any other text* | Delivered to the current session as a prompt, which starts a real model turn. |

Behaviour worth knowing:

- **Free text is a prompt.** It is written as a user message and triggers a model
  turn, exactly as if you had typed it in DSH. It is not a "chat with the bot".
- **The selection is global, not per chat.** One project and one session are
  selected for the whole bot instance. If two people (or two chats) talk to the
  same bot, they share the selection: whoever runs `/use` or `/new` last changes
  where everyone's next prompt goes. Run one bot per person if that matters.
- **Replies stream back.** While a turn runs, the plugin sends one message and
  edits it as the assistant produces text (edits are throttled to roughly one
  every 2.5 seconds; Telegram would otherwise rate-limit). Set `stream: false` to
  turn this off.
- **Turn end and errors are reported.** A turn that ends for an unusual reason
  (cancelled, failed) produces a short `⚠️ Turn ended: ...` note; an agent error
  produces `❌ Agent error: ...`.
- **Inline buttons** exist for projects, sessions, refresh, new session, status
  and stop, so the common flow needs no typing.
- **Long messages are split** into 4000-character chunks to stay under Telegram's
  4096 limit.

A typical first session:

```text
/projects      → tap the project
/new           → creates and selects a session
refactor the parser in src/parse.ts
/status
/cancel
```

---

## Security

`allowedUsers` is the only access control, and it is **strongly recommended**:

```yaml
config:
  allowedUsers: [123456789]
```

With `allowedUsers: []` (the default) **anyone who finds the bot can drive your
agent** — and the agent can run shell commands, edit files and read your
workspace, subject only to the DSH sandbox and approval settings of the Host. A
bot username is not a secret; bots are discoverable and can be found by scanning.

- Use numeric **user** ids, not usernames. Usernames can be changed; ids cannot.
- The allow-list is checked on every message and every button press.
- An unauthorized user gets `⛔ Not authorized.` plus their own id, and no action
  is performed. The event is logged as
  `telegram: rejected user <id> (not in allowedUsers)`.
- Anyone who can read the profile patch or the process environment can read the
  token. Treat the token like a password; revoke it with @BotFather (`/revoke`)
  if it leaks.
- The bot token is part of every Bot API URL, so avoid pasting full request URLs
  into bug reports.

---

## Troubleshooting

### The plugin logs "no token configured"

```text
telegram-bot: no token configured — set `token` in the profile patch for plugin "telegram-bot" or export DSH_TELEGRAM_BOT_TOKEN. Bot stays off.
```

The row loaded correctly but has no token. Add `token:` to the row's `config`, or
set `DSH_TELEGRAM_BOT_TOKEN`, then restart. The row is deliberately inert without
a token — it never dials out.

### `getMe failed — bot not started`

```text
telegram-bot: getMe failed — bot not started: POST transport failed: ...
```

The token is probably fine; the Host cannot reach the Bot API. Check in this
order:

1. Is the token right? A wrong token normally answers
   `Telegram getMe failed: Unauthorized` (HTTP 401) rather than a transport error.
2. Is the network blocking `api.telegram.org`? See
   [Blocked networks](#blocked-networks-and-the-proxy-setting) and set `proxy`.
3. Is the proxy running and on the port you configured? Test the port directly:

   ```powershell
   Test-NetConnection 127.0.0.1 -Port 1080
   ```

### "Not authorized"

```text
⛔ Not authorized.
Your Telegram user id is 123456789.
```

Your id is not in `allowedUsers`. Copy the printed number into the list and
restart. Do not add a username — ids are what the check compares.

### The bot does not respond at all

- **Is the row in the composition?** On Desktop, check **Settings → Plugins** for
  the `telegram-bot` row, or confirm the package is both a dependency and a
  `dsh.profile.bundles` entry. On another profile, dump the tree and look for the
  row (see [Verify the row is composed](#verify-the-row-is-composed)):

  ```powershell
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" --profile web --dump-config
  ```
- **Did startup log `polling as @your_bot`?** That line means `getMe` succeeded
  and polling started. If it is absent, the startup failed earlier.
- **Is another process polling the same token?** Telegram gives each update to one
  caller, so two DSH processes using one token (for example Desktop plus a
  `dsh web` boot with the plugin installed) each see a random subset of your
  messages. Use a separate bot per running instance, or run one instance.
- **Is a long poll still open?** With `pollTimeoutSeconds: 25` a new message can
  take up to ~25 s to arrive if the previous poll is in flight. Lower it to `5`
  while debugging.

### Restart vs hot reload

- A **configuration change** (profile `cordis.patch.yml`) is recomposed in place
  when the `hmr` entry is enabled; otherwise it applies on restart.
- **Plugin source changes** on a `link:` install are picked up by HMR's profile
  watches at the next recomposition. If HMR is not enabled, restart DSH.
- A **token or proxy change** always needs a restart to be safe: the running
  poller keeps its old client until the plugin is reloaded.

### Tests

The plugin ships a dependency-free test suite (a local mock Bot API, no network).
From this package directory:

```powershell
npm test
```

or directly, from this directory:

```powershell
node --test "test/*.test.mjs"
```

The `test/integration/` folder holds optional probes that boot a **real** DSH Host
with a mock Bot API; see [test/integration/README.md](test/integration/README.md).

---

## How it works

Short version, for when something is misbehaving:

1. **It is a Cordis Host plugin.** `lib/index.js` exports `name`, `inject`,
   `Config` and `apply`. `inject` is the list of Host services the row waits for
   (`sessionController`, `workspaceRegistry`, `sessions`); everything else
   (`workspaceController`, `agents`, `logger`, and the session-title projections)
   is read optionally through `ctx.get()`, so a minimal Host composition still
   mounts the row instead of hanging on a missing service.
2. **Startup resolves config, then `getMe`.** If there is no token, it logs and
   stops. If `getMe` fails, it logs the diagnostic and stops. Only after a
   successful `getMe` does it start polling, which is why a blocked network never
   produces a half-started bot.
3. **It long-polls `getUpdates`.** `lib/telegram-api.js` is a minimal Bot API
   client over `node:https`/`node:tls`/`node:net` with `CONNECT` and SOCKS5
   tunnels, bounded retries, 429 handling, and `getUpdates` `offset`
   acknowledgement. No npm dependencies.
4. **`lib/bot.js` routes updates.** Text commands and inline-button callbacks are
   handled there; anything that is not a command becomes a prompt.
5. **Prompts go through the session controller.** `sessionController.prompt()`
   writes a `source.kind = 'user'` message and starts a real turn, resuming a cold
   session if necessary. `lib/session-bridge.js` wraps the Host services so the
   router never touches Cordis directly.
6. **Replies come from Host events.** The bridge subscribes to
   `ctx.on('session/event', ..., { global: true })`, filters by session id, and
   extracts `assistant/message` text blocks. Those callbacks drive the throttled
   message edits. `/follow` additionally listens for the Host's session-activity
   notifications so a chat can track whichever session you are using in DSH.

Everything is Host-side, so there is no client bundle to build or reload.

---

## Known limitations

- **Markdown can need tuning.** Replies are sent with `parse_mode: Markdown`. If an
  agent reply contains unbalanced `*`/`_`, Telegram rejects the parse and the plugin
  automatically resends that message as plain text, so nothing is lost — but the
  formatting of that particular message is dropped. Set `markdown: false` to always
  send plain text.
- **Text only.** Photos, documents, voice notes and stickers are answered with
  `Only text messages are supported for now.`
- **One chat, one session.** A chat drives exactly one session at a time; use
  `/use` or `/follow` to change which. The selection is shared by every chat that
  talks to the bot.
- **One streaming target per session.** Live replies are tracked per session, so
  if two chats follow the *same* session, only the most recent one keeps receiving
  the streamed copy.
- **Session list is capped.** `/sessions` shows up to 25 sessions and `/projects`
  up to 30 inline buttons (Telegram limits how many a keyboard may hold).
- **Streaming is lossy by design.** Edits are throttled and only the tail of a
  very long reply is kept on screen (the last 3600 characters per edit), so the
  Telegram copy is a live view, not a transcript. The full text stays in DSH.

---

## License

MIT — see [LICENSE](./LICENSE).


