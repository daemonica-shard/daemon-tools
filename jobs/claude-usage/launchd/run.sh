#!/bin/sh
# launchd wrapper.
#
# Gotcha: launchd starts agents with a near-empty environment — no shell profile, so no nvm, so no
# `node` and no `npx` on PATH, and none of your secrets. Rather than putting a bot token into a
# world-readable plist in ~/Library/LaunchAgents, everything comes from one 600 env file.
set -eu

ENV_FILE="${CLAUDE_USAGE_ENV:-$HOME/.claude-usage/env}"
if [ -f "$ENV_FILE" ]; then
	. "$ENV_FILE"
	export PATH TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID
	export CLAUDE_USAGE_OTLP_ENDPOINT CLAUDE_USAGE_OTLP_TOKEN
fi

# Resolve the package from this script's own location, so the checkout can move without edits.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

exec "${NODE:-node}" "$DIR/dist/index.js" "$@"
