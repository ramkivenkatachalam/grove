#!/usr/bin/env bash
# Set Grove up on this Mac: check the tools it needs, link this checkout into the places Grove's pieces
# are loaded from, have every Claude Code session load the mod, and (with --app) build the app.
#   ./install.sh [--app] [<repo>…]     each <repo> is brought in with `grove import` (a dry run)
# Safe to re-run.
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
H="$HOME/.grove"
APP=0
REPOS=()
for a in "$@"; do
  case "$a" in
    --app) APP=1 ;;
    -h|--help) sed -n 2,5p "$0"; exit 0 ;;
    *) REPOS+=("$a") ;;
  esac
done

# 1. tools
missing=()
for t in git tmux gh claude python3; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ "$APP" = 1 ]; then command -v npm >/dev/null || missing+=("npm"); fi
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  for t in "${missing[@]}"; do
    case "$t" in
      claude) echo "  claude:  npm install -g @anthropic-ai/claude-code   (or see claude.com/claude-code)" ;;
      npm) echo "  npm:     brew install node" ;;
      *) echo "  $t:  brew install $t" ;;
    esac
  done
  exit 1
fi
gh auth status >/dev/null 2>&1 || echo "note: gh is not logged in (gh auth login); PR and CI status stay empty until it is"

# 2. links
mkdir -p "$H/bin" "$H/projects"
link() {  # link <target in repo> <live path>
  if [ -e "$2" ] && [ ! -L "$2" ]; then mv "$2" "$2.bak.$(date +%s)"; fi
  ln -sfn "$1" "$2"
  echo "linked $2 -> $1"
}
link "$R/cli/grove" "$H/bin/grove"
link "$R/cli/grove" "$H/bin/grove"  # the CLI's old name, kept so existing settings and habits still work
link "$R/mod" "$H/mod"
link "$R/tmux/grove.tmux.conf" "$H/tmux.conf"
mkdir -p "$HOME/.local/bin" && ln -sfn "$R/cli/grove" "$HOME/.local/bin/grove" && ln -sfn "$R/cli/grove" "$HOME/.local/bin/fh"

grep -q ".grove/tmux.conf" "$HOME/.tmux.conf" 2>/dev/null || echo "source-file $H/tmux.conf" >> "$HOME/.tmux.conf"

# 3. every Claude session loads the mod (and, if none is set, uses Grove's status line)
python3 - "$H" <<'PY'
import json, os, shutil, sys, time
hub = sys.argv[1]
path = os.path.expanduser("~/.claude/settings.json")
try:
    with open(path) as f:
        s = json.load(f)
except FileNotFoundError:
    s = {}
except ValueError:
    print(f"settings: {path} is not valid JSON; add env.CLAUDE_CODE_PLUGIN_DIRS = {hub}/mod yourself")
    sys.exit(0)
env = s.setdefault("env", {})
mod = f"{hub}/mod"
have = env.get("CLAUDE_CODE_PLUGIN_DIRS", "")
changed = []
if mod not in have.split(":"):
    env["CLAUDE_CODE_PLUGIN_DIRS"] = f"{have}:{mod}" if have else mod
    changed.append("CLAUDE_CODE_PLUGIN_DIRS")
if "statusLine" not in s:
    s["statusLine"] = {"type": "command", "command": f"{hub}/bin/grove statusline"}
    changed.append("statusLine")
if changed:
    if os.path.exists(path):
        shutil.copy2(path, f"{path}.bak.{int(time.time())}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    print(f"settings: set {', '.join(changed)} in {path} (backup kept next to it)")
else:
    print("settings: Claude Code already loads the Grove mod")
PY

# 4. the app
if [ "$APP" = 1 ]; then
  (cd "$R" && npm install && npm run install-app)
  "$H/bin/grove" ui app >/dev/null
  echo "app: /Applications/Grove.app"
fi

# 5. projects
for repo in "${REPOS[@]+"${REPOS[@]}"}"; do "$H/bin/grove" import "$repo"; done

cat <<MSG

Grove is installed. Next:
  - Bring in a repo and the work already on it:  grove import ~/code/my-repo
      (lists its worktrees and recent Claude conversations; add --yes to adopt them)
  - Start something new:                         grove new <name|TICKET-123>
  - Check everything:                            grove doctor
$( [ "$APP" = 1 ] || echo "  - The Mac app:                                 ./install.sh --app" )
Restart running Claude sessions so they load the mod.
MSG
