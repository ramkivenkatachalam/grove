# Grove

A Mac app for running several Claude Code agents at once, one per feature. Each feature grows in its
own git worktree with its own branch, ports, dev servers and Claude session; Grove shows them side by
side and tells you which one needs you.

![Grove on a demo project: the feature sidebar, the header (state, recap, next step, PR and CI, stage), Claude in the main panel, a service log and a shell on the right](docs/screenshot.png)

## What you get

- **One window per project**, its name at the top of the sidebar; ⇄ opens another project and shows
  how many features need you elsewhere. Grove reopens the projects you had open.
- **Sidebar** (Warp-style): every feature with its state (❗ needs you · ✓ your turn · ⏳ working),
  title, branch and PR/CI. Search (⌘K), **+ New** (⌘N), double-click to rename, right-click for more.
- **Header**: the feature's title, state, a one-line recap, the **next step**, PR / CI / review
  findings, git status, ports and the lifecycle stage (Explore → … → Merged).
- **Main panel**: the feature's live Claude Code session.
- **Panels**: shell, backend and frontend logs, opened on the right (⌘⌥S / ⌘⌥B / ⌘⌥F) and zoomable (⌘⇧↩).
- **Spin-offs**: inside any session, ask Claude to *spin off a related feature*; it writes a handover
  brief, Grove creates the feature and switches to it.
- **Dock badge** with the number of features waiting on you, plus desktop notifications.

Quitting Grove stops nothing: every terminal is a tmux session (`fh_<feature>_<pane>`) that keeps running.

## How it fits together

| Piece | Where | Role |
|---|---|---|
| App | `main.js`, `preload.js`, `ptybridge.py`, `renderer/` | Electron + React + xterm.js. Reads state from `~/.claude/feature-hub`, attaches terminals to tmux sessions through a tiny Python pty bridge (no native modules) |
| `grove` CLI (`fh`) | `cli/fh` | Python, stdlib only. Projects, worktrees, per-service port allocation, env rewriting, dev servers, PR/CI sync, review-bot findings, ticket briefs, cleanup, `grove doctor` |
| Claude Code mod | `mod/` | Function hooks loaded by every Claude Code session: publishes each session's state, recap and next step, notifications, the `new_feature` tool, `/feature` commands |
| tmux config | `tmux/grove.tmux.conf` | The terminal-only front end (header in tmux's status line), used with `fh ui tmux` |

State lives in `~/.claude/feature-hub/`: `features/*.json` (registry), `status/*.json` (per-session
state written by the mod), `projects/*.json`, `prs.json`, `theme.json`, `config.json`.

## Projects

Grove works with any git repo. A project config says how to grow a feature from it:

```sh
grove project add ~/code/my-repo     # reads my-repo/.grove.json, or writes a starter config
grove new csv-export                 # in or outside the repo; --project picks one explicitly
```

The config is the repo's own **`.grove.json`** (commit it to share it with your team) merged under
**`~/.claude/feature-hub/projects/<name>.json`** (yours; at least `{"repo": "~/code/my-repo"}`).

| Key | What it does |
|---|---|
| `services` | Dev servers, each `{name, dir, run, ports: [lo, hi], reserved, key, hint, open}`. Every feature gets its own port per service; each service is a panel |
| `setup` | Preparing a new worktree: `link` (symlink to the main checkout's copy, e.g. a venv), `clone` (copy-on-write clone, e.g. node_modules), `copy` (e.g. env files), `run` (shell commands) |
| `env` | Rewrites per worktree: `port` points `localhost:NNNN` in a key at a service; `set` sets a whole value (`{web}` = the web port) |
| `labels` | Shows a value from an env file as a label (e.g. which database) and warns on some (e.g. `PROD`) |
| `checks`, `agentNotes` | What Claude should run before finishing, and anything else it should know |
| `base`, `branchPrefix`, `worktrees` | Branch start point, branch naming (`{user}/`), where worktrees go |

See [`examples/nextjs-fastapi.grove.json`](examples/nextjs-fastapi.grove.json).

## Install

```sh
./install.sh                 # links cli/, mod/ and tmux/ into ~/.claude/feature-hub
npm install
npm run install-app          # builds Grove.app into /Applications
```

Then add the settings lines `install.sh` prints, so every Claude session loads the mod.

## Develop

| Task | Command |
|---|---|
| Run from source | `npm start` |
| Rebuild and reinstall the app | `npm run install-app` (quit Grove first) |
| Regenerate the icon from `build/icon.svg` | `npm run icon` |
| Screenshot the app (visual checks) | `FH_SCREENSHOT=/tmp/grove.png npx electron .` |
| Validate / test the mod | `claude plugin validate mod && claude plugin test mod` |

## Keys

⌘1–9 switch feature · ⌘⇧1–9 open project · ⌘⇧O add project · ⌘N new · ⌘E rename · ⌘K find · ⌘⌥S/B/F shell/be/fe · ⌘⇧↩ zoom panel ·
⌘⇧R restart servers · right-click a feature for more · ⌥-drag selects text inside a terminal.
