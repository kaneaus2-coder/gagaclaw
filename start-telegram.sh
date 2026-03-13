#!/bin/bash
cd "$(dirname "$0")"

ensure_antigravity() {
    if ! curl -s http://127.0.0.1:9229/json/version > /dev/null 2>&1; then
        echo "[start] Starting Antigravity..."
        antigravity --no-sandbox --remote-debugging-port=9229 &
        sleep 5
    fi
}

ensure_antigravity

echo "[start] Starting Telegram Bot (telegram-agent)..."
while true; do
    node telegram.js telegram-agent
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 42 ]; then
        echo ""
        echo "[Restart] Restarting telegram.js telegram-agent..."
        echo ""
        ensure_antigravity
    else
        echo "[$(date +%H:%M:%S)] telegram.js exited with code $EXIT_CODE"
        break
    fi
done
