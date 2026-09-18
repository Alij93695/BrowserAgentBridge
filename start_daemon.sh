#!/usr/bin/env bash
# Start BrowserAgentBridge Daemon in background on macOS / Linux
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Check if port 1313 is already in use
if lsof -Pi :1313 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "[*] BrowserAgentBridge Daemon is already running on port 1313."
    exit 0
fi

# Detect python executable
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
else
    PYTHON_CMD="python"
fi

echo "[+] Starting BrowserAgentBridge Daemon on http://127.0.0.1:1313 ..."
nohup $PYTHON_CMD daemon.py > webbridge.log 2>&1 &
PID=$!
echo "[+] Daemon started with PID $PID. Logs: $DIR/webbridge.log"
