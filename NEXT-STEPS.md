# dsh-plugin-telegram — ready to use

Installed and verified. One step is left for you: **a bot token**.

## 1. Create the bot (1 minute)

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, pick a name and a username ending in `bot`.
3. Copy the token it prints — looks like `123456789:AAH...`.

## 2. Get your numeric user id

Send any message to **@userinfobot** (or @RawDataBot); it replies with your id,
e.g. `123456789`. Do not use your @username — the allow-list needs the number.

## 3. Put the token into the Desktop profile

Edit `C:\Users\Mediatar\.dsh\profiles\desktop\cordis.patch.yml` and append this row
at the end of the file (it is a YAML list — keep the indentation):

```yaml
- id: telegram-bot
  name: dsh-plugin-telegram
  config:
    token: "123456789:AAH-your-real-token"
    allowedUsers: [123456789]
    # Only if api.telegram.org is blocked on your network:
    # proxy: "socks5://127.0.0.1:1080"
```

The plugin's own bundle patch already inserts the `telegram-bot` row; this entry
adds the configuration to that same id. Do not add a second `insert` row.

## 4. Restart DeepSeek Harness

Fully quit and start the Desktop app (a config change is recomposed on restart;
a token change always needs one).

## 5. Talk to your bot

Send `/start` to your bot in Telegram. Then:

- `/projects` → tap a project
- `/sessions` → tap a session, or `/new` to create one
- just type → it becomes a prompt in that session, and the agent's reply streams
  back into the chat
- `/follow` → the chat tracks whichever session you are working in inside DSH

## If the bot stays silent

`api.telegram.org` is **not reachable from this machine** (verified: TCP 443 to
149.154.x hangs, no proxy configured). The plugin prints this on startup:

```text
telegram-bot: api.telegram.org looks unreachable from this host. Configure `proxy`
(http:// or socks5://) for plugin "telegram-bot", or export DSH_TELEGRAM_PROXY.
```

In that case set `proxy:` to a working HTTP or SOCKS5 proxy. Any local proxy
client that exposes a SOCKS5 port works, for example `socks5://127.0.0.1:1080`.
The plugin supports `http://`, `https://` and `socks5://` (with optional
`user:pass@`) and needs no extra packages for them.

Everything else — projects, sessions, prompts, streaming — was verified against a
real DSH Host with a mock Bot API, so it works as soon as the network path is open.
