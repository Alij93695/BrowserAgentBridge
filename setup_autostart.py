import os
import sys
import subprocess

def setup_windows(current_dir, daemon_path):
    startup_dir = os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup")
    vbs_path = os.path.join(startup_dir, "StartBrowserAgentBridge.vbs")
    
    pythonw_path = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
    if not os.path.exists(pythonw_path):
        pythonw_path = "pythonw.exe"
    
    # VBScript content to run daemon.py windowless using absolute pythonw.exe path
    vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """{pythonw_path}"" ""{daemon_path}""", 0, False
'''
    try:
        with open(vbs_path, "w", encoding="utf-8") as f:
            f.write(vbs_content)
        print(f"[+] Successfully registered BrowserAgentBridge to launch on Windows startup!")
        print(f"    Startup Script: {vbs_path}")
        
        # Run it right now silently
        os.system(f'wscript.exe "{vbs_path}"')
        print(f"[+] Daemon started silently in the background.")
    except Exception as e:
        print(f"[-] Failed to register Windows startup script: {e}")

def setup_macos(current_dir, daemon_path):
    launch_agents_dir = os.path.expanduser("~/Library/LaunchAgents")
    os.makedirs(launch_agents_dir, exist_ok=True)
    plist_path = os.path.join(launch_agents_dir, "com.browseragentbridge.daemon.plist")
    log_path = os.path.join(current_dir, "webbridge.log")
    python_bin = sys.executable

    plist_content = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.browseragentbridge.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>{python_bin}</string>
        <string>{daemon_path}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>{current_dir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
</dict>
</plist>
'''
    try:
        with open(plist_path, "w", encoding="utf-8") as f:
            f.write(plist_content)
        print(f"[+] Successfully created macOS LaunchAgent at: {plist_path}")
        
        # Unload if previously loaded, then load
        subprocess.run(["launchctl", "unload", plist_path], capture_output=True)
        res = subprocess.run(["launchctl", "load", "-w", plist_path], capture_output=True, text=True)
        if res.returncode == 0:
            print("[+] Successfully registered and launched daemon via macOS launchctl!")
        else:
            print(f"[*] Note: Run 'launchctl load -w {plist_path}' or './start_daemon.sh' to start.")
    except Exception as e:
        print(f"[-] Failed to register macOS LaunchAgent: {e}")

def main():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    daemon_path = os.path.join(current_dir, "daemon.py")

    if sys.platform == "win32":
        setup_windows(current_dir, daemon_path)
    elif sys.platform == "darwin":
        setup_macos(current_dir, daemon_path)
    else:
        print(f"[*] Platform '{sys.platform}' detected. Use ./start_daemon.sh or run 'python3 daemon.py'.")

if __name__ == "__main__":
    main()
