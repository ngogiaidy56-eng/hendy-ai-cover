#!/usr/bin/env bash
set -euo pipefail
OWNER="ngogiaidy56-eng"
REPO="hendy-ai-cover"
FULL_NAME="$OWNER/$REPO"

command -v gh >/dev/null 2>&1 || { echo "Install GitHub CLI: https://cli.github.com/" >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Install Git." >&2; exit 1; }
gh auth status

if [[ ! -d .git ]]; then git init -b main; fi
git add -A
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git commit -m "Initial Hendy AI Cover Basic release"
elif ! git diff --cached --quiet; then
  git commit -m "Update Hendy AI Cover Basic"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$FULL_NAME" --private --source . --remote origin --push \
    --description "Hendy AI Cover Basic - Telegram AI cover with licensed preset voice conversion"
else
  ORIGIN="$(git remote get-url origin)"
  [[ "$ORIGIN" =~ github\.com[:/]ngogiaidy56-eng/hendy-ai-cover(\.git)?$ ]] || {
    echo "origin is pointing to another repository: $ORIGIN" >&2; exit 1;
  }
  git push -u origin main
fi
printf 'Repository ready: https://github.com/%s\n' "$FULL_NAME"
