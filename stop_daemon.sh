#!/usr/bin/env bash
# Stop BrowserAgentBridge Daemon on macOS / Linux
PID=$(lsof -ti:1313)
if [ -n "$PID" ]; then
    echo "[+] Stopping BrowserAgentBridge Daemon (PID: $PID)..."
    kill -15 $PID 2>/dev/null || kill -9 $PID 2>/dev/null
    echo "[+] Stopped."
else
    echo "[*] No daemon process found running on port 1313."
fi
