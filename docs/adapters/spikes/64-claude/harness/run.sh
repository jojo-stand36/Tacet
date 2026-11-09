#!/bin/bash
S=$(cd "$(dirname "$0")" && pwd)
cd "$S/work"
exec env -i PATH="$S/node_modules/.bin:/usr/bin:/bin:$(dirname $(which node))" HOME="$S/home" CLAUDE_CONFIG_DIR="$S/home/.claude" \
  ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=sk-ant-dummy-not-a-key \
  DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  claude "$@"
