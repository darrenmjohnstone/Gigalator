#!/bin/bash
# Gigalator Manager — double-click to launch
cd "$(dirname "$0")/manager-app"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

# Launch the Electron app
npx electron .
