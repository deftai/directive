#!/usr/bin/env sh
# Deft Directive — agent skill installer
# Usage:
#   curl -sSL https://raw.githubusercontent.com/visionik/deft/master/skills/install.sh | sh
#
# Clones the deft framework and wires up the deft skills so your AI agent
# (Claude Code, OpenCode, Codex, Warp, etc.) discovers them automatically.
#
# Skills installed:
#   deft-setup  — Conversational project setup (user prefs, project config, spec)
#   deft-build  — Implement a spec following deft standards
#
# Options:
#   --global          Install skills to your home directory (all projects)
#   --no-clone        Skip cloning deft (use if deft/ already exists)
#   --branch <name>   Clone a specific branch (default: master)
#   --repo <url>      Clone from a different repo URL

set -e

REPO_URL="https://github.com/visionik/deft.git"
BRANCH="master"
DEFT_DIR="deft"
SKILLS="deft-setup deft-build"
GLOBAL=false
CLONE=true

while [ $# -gt 0 ]; do
  case "$1" in
    --global)    GLOBAL=true ;;
    --no-clone)  CLONE=false ;;
    --branch)    shift; BRANCH="$1" ;;
    --repo)      shift; REPO_URL="$1" ;;
  esac
  shift
done

# --- Clone deft if needed ---------------------------------------------------

if [ "$CLONE" = true ]; then
  if [ -d "$DEFT_DIR" ]; then
    echo "deft/ already exists, skipping clone."
  else
    echo "Cloning deft framework (branch: $BRANCH)..."
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$DEFT_DIR"
  fi
fi

# Verify skills exist
for skill in $SKILLS; do
  if [ ! -f "$DEFT_DIR/skills/$skill/SKILL.md" ]; then
    echo "Error: $DEFT_DIR/skills/$skill/SKILL.md not found." >&2
    echo "Make sure deft is cloned at ./$DEFT_DIR" >&2
    exit 1
  fi
done

# --- Link skills for each platform ------------------------------------------

link_skill() {
  target_dir="$1"
  source_path="$2"
  skill_name="$3"

  mkdir -p "$target_dir"
  if [ -e "$target_dir/$skill_name" ] || [ -L "$target_dir/$skill_name" ]; then
    echo "  $target_dir/$skill_name already exists, skipping."
  else
    ln -s "$source_path" "$target_dir/$skill_name"
    echo "  Linked $target_dir/$skill_name"
  fi
}

if [ "$GLOBAL" = true ]; then
  echo "Installing skills globally..."

  for skill in $SKILLS; do
    SKILL_SRC="$(cd "$DEFT_DIR/skills" && pwd)/$skill"

    # .agents/skills/ — Codex, OpenCode, Warp
    link_skill "$HOME/.agents/skills" "$SKILL_SRC" "$skill"

    # .claude/skills/ — Claude Code, OpenCode, Warp
    link_skill "$HOME/.claude/skills" "$SKILL_SRC" "$skill"
  done

else
  echo "Installing skills for this project..."

  for skill in $SKILLS; do
    REL_PATH="../../$DEFT_DIR/skills/$skill"

    # .agents/skills/ — Codex, OpenCode, Warp
    link_skill ".agents/skills" "$REL_PATH" "$skill"

    # .claude/skills/ — Claude Code, OpenCode, Warp
    link_skill ".claude/skills" "$REL_PATH" "$skill"
  done
fi

# --- Done --------------------------------------------------------------------

echo ""
echo "Deft has been installed."
echo ""
echo "Open your favorite coding agent here and ask it to set up deft."
echo ""
echo "Supported: Claude Code, OpenCode, Codex, Warp"
