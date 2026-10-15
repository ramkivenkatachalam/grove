# Grove — working notes for Claude

Grove is a Mac app plus a CLI and a Claude Code mod for running several Claude Code agents side by side,
one git worktree per feature. README.md is the user-facing description; this file is how to work on it.

## Pieces and where they live

| Piece | Source | Live location (symlinked to the source) |
|---|---|---|
| CLI `grove` (Python 3, **stdlib only**) | `cli/grove` | `~/.grove/bin/grove`, `~/.local/bin/grove` |
| Claude Code mod (function hooks, TypeScript) | `mod/` | `~/.grove/mod`, loaded via `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` |
| Mac app (Electron 44 + React 19 + xterm.js 6) | `main.js`, `preload.js`, `ptybridge.py`, `renderer/` | `/Applications/Grove.app` (a built copy: rebuild to update) |
| tmux front end | `tmux/grove.tmux.conf` | `~/.grove/tmux.conf`, sourced from `~/.tmux.conf` |

Runtime state, never in git: `~/.grove/` — one folder per project, `projects/<p>/project.json`
(per-project config, private to each person), and in it one folder per feature, `projects/<p>/<f>/`
with `feature.json` (registry), `status.json` (written by the mod), `brief.md` and `worktree/` (the git
worktree, or a link to one made before this layout). `grove done` deletes a feature's folder, keeping its
notes and retro in `projects/<p>/archive/<f>/`. Beside `project.json`: `prs.json`, `findings.json`, `github.json` (GitHub state is per project:
branch names are only unique within one repo). At the top: `theme.json`,
`config.json` (`ui: app|tmux`, `defaultProject`), `focus.json`. Feature names are unique across projects
(tmux sessions are named by them). The app's file watcher ignores everything under `worktree/`.

How they connect: the app only draws (reads state files, attaches terminals); the CLI does the work; the
mod reports from inside each Claude session; tmux hosts every process (`grove_<feature>_<pane>` sessions).

## Working rules

- **Edit the source here** — the live locations are symlinks, so CLI and mod edits are live immediately.
  Running Claude sessions do *not* hot-reload the mod: restart them (`claude --continue`) to pick changes up.
- **CLI**: stdlib only, no third-party imports. `python3 -m py_compile cli/grove` and `python3 -m unittest discover tests` after edits. Every command
  must stay safe to re-run (host, adopt, provision are idempotent).
- **Mod** (`mod/hooks/register.tsx`), the function-hooks API:
  - A helper that takes `$` must be a top-level function declaration (the validator rejects closures).
  - Type-check: point a scratch tsconfig at the engine's types (the plugin-authoring skill's `types/claude-code.d.ts`).
  - `claude plugin validate mod && claude plugin test mod`. All tests must pass. Add a test for new behaviour.
  - If `claude plugin test` says hooks modules are switched off ("rollout switch saved off"), run
    `claude -p "ok"` once to refresh it, then retest.
- **App**: no native node modules (terminals go through `ptybridge.py`). After renderer edits: `npm run build`.
  Check visuals with a screenshot, not by guessing:
  `GROVE_PROJECT=<name> GROVE_SCREENSHOT=/tmp/g.png npx electron .` (optionally `GROVE_SCREENSHOT_JS='…'` to set
  localStorage first, `GROVE_HUB=…` to use a throwaway hub). Then `npm run install-app` (quit Grove first).
- **Test generically**: anything touching projects, worktrees or services gets an end-to-end run against a
  throwaway project with `env -u TMUX GROVE_HUB=/tmp/x/hub GROVE_BIN=$PWD/cli/grove TMUX_TMPDIR=/tmp/x/tm`
  (keep the TMUX_TMPDIR path short: tmux socket paths have a length limit). Never test against the user's
  live hub, and unset `TMUX` (see the first gotcha).
- **Accessibility**: every state carries a word, not just a colour; text ≥ 4.5:1 on its background;
  every click has a key.
- **Commits**: this checkout commits as `ramkivenkatachalam <ramki@utexas.edu>`; no mention of Claude in
  commit messages. Push to `origin` (github.com/ramkivenkatachalam/grove). Any other remote, and the branch
  `work-main`, are frozen history — don't push there.
- **Never put config for a particular project in this repo** (no company, repo or service names). Project
  specifics belong in that project's `.grove.json` or the user's private `~/.grove/projects/<name>/project.json`.

## Gotchas learned the hard way

- **Never touch the live tmux server from a test.** Agents run inside Grove's tmux panes, where `$TMUX` is set
  and beats `TMUX_TMPDIR`: a test that only sets `TMUX_TMPDIR` still drives the live server, and its
  `kill-server` stops every agent and service (it happened, twice). Use `env -u TMUX` / `unset TMUX` with
  `TMUX_TMPDIR`, or `tmux -S <socket>` on every call. The mod blocks the risky forms (`liveTmuxRisk`).
- macOS `sleep infinity` exits at once — use `sleep 2147483647`.
- tmux `set-option -t` takes a pane target: write `=<session>:` (with the colon) for a session.
- zsh aborts a whole command line when a glob matches nothing (`rm -f 7-*.svg`): guard or avoid globs.
- Claude Code keeps showing its last status line until it re-runs the command; `grove statusline` therefore
  never prints an empty line in app mode.
- A Claude conversation can only be resumed from the folder it started in (transcripts are stored per
  folder under `~/.claude/projects/`), so session rows keep their original path.
- A feature shows `offline` when the Claude pid in its status.json is gone or the status predates the last
  boot (`session_live` in the CLI, `sessionLive` in main.js; no process is started). A status without a pid
  is trusted until the next reboot.
- `grove adopt` rewrites a worktree's env files to its new ports; services start stopped.
- Offscreen Electron `capturePage` can return the previous frame: settle (two rAFs + a beat) and capture twice.

## Open items

- Pitch video (`~/Desktop/Grove-pitch-music.mp4`): source and renderer were in a session scratchpad; if it
  needs more edits, move them into `docs/video/` first.
