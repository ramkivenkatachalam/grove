#!/usr/bin/env bash
# Link this checkout into the places Grove's pieces are loaded from, and build the app.
#   ./install.sh
set -euo pipefail
R="$(cd "$(dirname "$0")" && pwd)"
H="$HOME/.grove"
mkdir -p "$H/bin" "$H/projects"

link() {  # link <target in repo> <live path>
  if [ -e "$2" ] && [ ! -L "$2" ]; then mv "$2" "$2.bak.$(date +%s)"; fi
  ln -sfn "$1" "$2"
  echo "linked $2 -> $1"
}
link "$R/cli/grove" "$H/bin/grove"
link "$R/cli/grove" "$H/bin/fh"  # the CLI's old name, kept so existing settings and habits still work
link "$R/mod" "$H/mod"
link "$R/tmux/grove.tmux.conf" "$H/tmux.conf"
mkdir -p "$HOME/.local/bin" && ln -sfn "$R/cli/grove" "$HOME/.local/bin/grove" && ln -sfn "$R/cli/grove" "$HOME/.local/bin/fh"

grep -q ".grove/tmux.conf" "$HOME/.tmux.conf" 2>/dev/null || echo "source-file $H/tmux.conf" >> "$HOME/.tmux.conf"

cat <<MSG

Next:
  1. Load the Claude Code mod in every session: add to ~/.claude/settings.json
       "env": { "CLAUDE_CODE_PLUGIN_DIRS": "$H/mod" }
     and optionally the status line:
       "statusLine": { "type": "command", "command": "$H/bin/grove statusline" }
  2. Register a project:         grove project add ~/code/my-repo   (see examples/ for .grove.json)
  3. Build and install the app:  npm install && npm run install-app
  4. Check the setup:            grove doctor
MSG
