#!/usr/bin/env bash
# Symlink this skill into every agent skill directory found for the current user.
#
#   scripts/install.sh [--dry-run] [--uninstall]
#
# Targets (only for tools that are present):
#   Claude Code   <config dir>/skills for ~/.claude, every other Claude profile dir
#                 (~/.claude-*, ~/.config/claude*, $CLAUDE_CONFIG_DIR, CLAUDE_CONFIG_DIR=... in shell rc
#                 files, ~/.agy-profiles/*/home/.claude); a dir counts as a profile if it has
#                 settings.json, .claude.json, .credentials.json or projects/.
#   Codex         ~/.agents/skills (current user-level location; ~/.codex/skills is not linked to
#                 avoid duplicate entries) and $CODEX_HOME/skills when CODEX_HOME is non-default.
#   Antigravity   ~/.gemini/config/skills (app/IDE) and ~/.gemini/antigravity-cli/skills (CLI), also
#                 inside each ~/.agy-profiles/*/home.
# Existing symlinks are replaced; real directories with the same name are left alone.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
NAME="pareto-delegate"
DRY=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

declare -a TARGETS=()
add() { # add <skills-dir>
  local d="$1" t
  for t in "${TARGETS[@]+"${TARGETS[@]}"}"; do [[ "$t" == "$d" ]] && return; done
  TARGETS+=("$d")
}

is_claude_profile() {
  local d="$1"
  [[ -d "$d" ]] || return 1
  [[ -f "$d/settings.json" || -f "$d/.claude.json" || -f "$d/.credentials.json" || -d "$d/projects" ]]
}

# --- Claude Code profiles -------------------------------------------------------------------
declare -a CLAUDE_CANDIDATES=("$HOME/.claude")
for d in "$HOME"/.claude-* "$HOME"/.claude_* "$HOME"/.config/claude* "$HOME"/.agy-profiles/*/home/.claude; do
  [[ -e "$d" ]] && CLAUDE_CANDIDATES+=("$d")
done
[[ -n "${CLAUDE_CONFIG_DIR:-}" ]] && CLAUDE_CANDIDATES+=("$CLAUDE_CONFIG_DIR")
for rc in "$HOME"/.zshrc "$HOME"/.zprofile "$HOME"/.zshenv "$HOME"/.bashrc "$HOME"/.bash_profile "$HOME"/.profile "$HOME"/.config/fish/config.fish; do
  [[ -f "$rc" ]] || continue
  while IFS= read -r val; do
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    val="${val/#\~/$HOME}"; val="${val//\$HOME/$HOME}"; val="${val//\$\{HOME\}/$HOME}"
    [[ -n "$val" ]] && CLAUDE_CANDIDATES+=("$val")
  done < <(grep -oE 'CLAUDE_CONFIG_DIR[= ]+[^ ;&|)]+' "$rc" 2>/dev/null | sed -E 's/^CLAUDE_CONFIG_DIR[= ]+//')
done
for d in "${CLAUDE_CANDIDATES[@]}"; do
  [[ -e "$d" ]] || continue
  d="$(cd "$d" && pwd -P)"
  [[ "$d" == "$SKILL_DIR"* ]] && continue
  is_claude_profile "$d" && add "$d/skills"
done

# --- Codex ------------------------------------------------------------------------------------
if [[ -d "$HOME/.codex" || -d "$HOME/.agents" ]]; then add "$HOME/.agents/skills"; fi
if [[ -n "${CODEX_HOME:-}" && "$(cd "$CODEX_HOME" 2>/dev/null && pwd -P)" != "$(cd "$HOME/.codex" 2>/dev/null && pwd -P)" ]]; then
  add "$CODEX_HOME/skills"
fi

# --- Antigravity ------------------------------------------------------------------------------
for home in "$HOME" "$HOME"/.agy-profiles/*/home; do
  [[ -d "$home/.gemini" ]] || continue
  add "$home/.gemini/config/skills"
  [[ -d "$home/.gemini/antigravity-cli" ]] && add "$home/.gemini/antigravity-cli/skills"
done

# --- Apply ------------------------------------------------------------------------------------
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No agent skill directories found."
  exit 0
fi

run() { if [[ $DRY -eq 1 ]]; then echo "  would: $*"; else "$@"; fi; }

for dir in "${TARGETS[@]}"; do
  link="$dir/$NAME"
  if [[ $UNINSTALL -eq 1 ]]; then
    if [[ -L "$link" ]]; then run rm "$link"; [[ $DRY -eq 1 ]] || echo "removed  $link"; fi
    continue
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    echo "skipped  $link (exists and is not a symlink)"
    continue
  fi
  if [[ -L "$link" && "$(readlink "$link")" == "$SKILL_DIR" ]]; then
    echo "ok       $link"
    continue
  fi
  run mkdir -p "$dir"
  [[ -L "$link" ]] && run rm "$link"
  run ln -s "$SKILL_DIR" "$link"
  [[ $DRY -eq 1 ]] || echo "linked   $link -> $SKILL_DIR"
done
