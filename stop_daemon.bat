@echo off
echo Stopping BrowserAgentBridge Daemon on port 1313...
powershell -Command "Stop-Process -Id (Get-NetTCPConnection -LocalPort 1313).OwningProcess -ErrorAction SilentlyContinue -Force"
echo Done.
