#!/bin/bash
# Gigalator Deploy — double-click this file to push changes to your iPad app

cd "$(dirname "$0")"

echo ""
echo "═══════════════════════════════════════"
echo "  Gigalator — Deploying to iPad app"
echo "═══════════════════════════════════════"
echo ""

# Check for changes
if git diff --quiet && git diff --cached --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "✓ No changes to deploy. Everything is up to date."
  echo ""
  echo "Press any key to close..."
  read -n 1
  exit 0
fi

echo "Changes found:"
git status --short
echo ""

# Stage, commit, push
git add .
git commit -m "Update songs — $(date '+%d %b %Y %H:%M')"

if git push; then
  echo ""
  echo "═══════════════════════════════════════"
  echo "  ✓ Deployed! Open your iPad app on"
  echo "    WiFi to pick up the changes."
  echo "═══════════════════════════════════════"
else
  echo ""
  echo "═══════════════════════════════════════"
  echo "  ✗ Push failed. Check your internet"
  echo "    connection and try again."
  echo "═══════════════════════════════════════"
fi

echo ""
echo "Press any key to close..."
read -n 1
