# agentADB for mtty

Tools that test the mtty app through its mttyd. They live in the agentADB repo next to the generic phone driver `pp` (`../bin/pp`). Nothing here changes the app.

Set these for mtty: `export PP_PKG=com.spizganed.mtty.dev`, and put `bin` and `mtty/bin` of this repo on PATH.

## `bin/pt`: type into the app without the keyboard

`pt` talks to mttyd **inside the running app** over its WebSocket. It reads the login token with `adb shell run-as`, so it needs a **debug build** of the app (a release build refuses `run-as`). The token is never printed.

```sh
pt sessions                                   # list sessions: name, agent, folder, title
pt new linktest /root/projects/sandbox shell  # start a session (the path is inside the app's Linux system)
PT_MODE=bypassPermissions pt new t /root/projects/sandbox antigravity  # PT_MODE: the permission mode of the new session
pt send linktest 'any text & symbols'         # paste the text into the session and press Enter
pt capture linktest                           # print the screen text
pt kill linktest
pt watch linktest 10                          # attach and print the chat and usage messages mttyd sends to the app
PT_TIME=1 pt watch linktest 60                # the same with the time in ms before each line; alerts (done, waiting) too
pt call '{"t":"models","harness":"codex"}' models   # send any message, print the reply
```

No phone keyboard and no clipboard are involved, so the text arrives exactly as sent. The app shows a session that `pt` starts without any tap. Use `pp` for the Compose screens and `pt` for terminals and agents. `adb shell input text` is the only way to type into an app text field without the clipboard, and it goes through the keyboard layer: use `pp type` there.

## `bin/px`: run a command in the Linux system of the dev app

```sh
px 'apt-get -v | head -1; id -u'   # any shell line: quotes, pipes and $ pass as typed
PX_DISTRO=debian PX_MODE=proot px 'uname -a'
```

It runs the system as the app does: fastroot for `files/ubuntu`, through `tools/fastroot/bench/run-in.sh` of the mtty repo (copied to the cache of the app). `PX_RUNIN` names another copy of that script. Debug build only (run-as).

## `tests/claude-canary.mjs`: a real Claude Code through mttyd

```sh
node tests/claude-canary.mjs [path/to/mttyd]
```

Run it after each update of Claude Code. It uses the login of `~/.claude-b` in an isolated `HOME` and the model Haiku. It checks the permission card (hook), the question form, a dialog with no card (`waiting`), the slash command list and the report. A line that fails names the part of the app that the new version broke.

## `tests/run.mjs`: protocol tests for mttyd

```sh
node tests/run.mjs [path/to/mttyd]   # default: ~/projects/mtty/mttyd, else ~/projects/Purrminal/mttyd
```

It starts an isolated mttyd (new empty `HOME`, a random port, its own tmux socket through `MTTY_SOCK`) and sends the same WebSocket messages the app sends. It cannot touch your real login, sessions or the running mttyd. No taps, no screenshots. It runs in a few seconds.

It covers the session list, the agent and account lists, a shell session start and end, a session that another client starts, refused bad input, History (Codex and OpenCode chats), the Claude Code spinner and queue, Claude Code accounts and unknown messages. To add a test, add a `test('name', async () => { ... })` block.

Limits: it runs a mttyd from the repo with an empty `HOME`, so it does not test the real `gh` or `glab` setup. It does not test Compose screens. Use `pp` for those.
