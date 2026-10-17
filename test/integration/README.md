# Integration probes (real DSH Host)

These scripts boot a **real** DeepSeek Harness profile with this plugin installed
and drive it through a local mock Bot API. They are not part of `npm test`: they
spawn the DSH CLI, take 30–90 s each, and need the plugin installed as a profile
bundle.

They exist because unit tests use fakes. These probes prove the parts that only a
real Host can prove: that the Cordis row activates, that the config schema is
accepted, that `sessionController`/`workspaceRegistry` return what the bridge
expects, and that real `session/event` traffic reaches the chat.

## Prerequisites

1. The DSH CLI (bundled with the Desktop app):
   `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`
2. The plugin installed into the `web` profile (a real, non-Electron-managed
   profile — the `desktop` profile refuses CLI boot by design):

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
       plugin --profile web add "link:<absolute path to this package>"
   ```

3. No `api.telegram.org` access is needed — every probe points the client at a
   mock server on `127.0.0.1`.

## Probes

| Script | What it proves |
| --- | --- |
| `host-probe.mjs` | The row activates in a real Host; `/start`, `/projects`, project buttons, `/new`, `/status`, `/sessions`, free-text prompts, `/cancel` and allow-list rejection all work against real DSH services. |
| `stream-probe.mjs` | A real `assistant/message` appended to a real session log is mirrored into the chat, a second message extends the same message, and the watcher is released at `turn/end`. Loads an extra probe plugin via `--patch` to append genuine session events. |
| `config-probe.mjs` | The documented `cordis.patch.yml` configuration path (token + `allowedUsers` from the profile patch, no environment variables) starts the bot and enforces the allow-list. |

Run one from the repository root:

```powershell
node test/integration/host-probe.mjs
```

Each probe prints `PASS`/`FAIL` per check, a final `n/n checks passed`, and the
host log tail on failure. They kill the Host process they spawned and exit
non-zero when a check fails.

## Notes

- `config-probe.mjs` expects `~/.dsh/profiles/web/cordis.patch.yml` to contain a
  `telegram-bot` row with `token`, `allowedUsers` and a short
  `pollTimeoutSeconds`. Add it before running, and remove it afterwards.
- `stream-probe.mjs` writes a temporary probe plugin and patch file into
  `research/` and a port file used for handshake; both are disposable.
- The Host logs `telegram-bot:` lines to **stderr**, because Cordis's
  `ctx.logger` is not rendered by the `dsh` CLI.

