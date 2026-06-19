import os
import sys

def main():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    daemon_path = os.path.join(current_dir, "daemon.py")
    
    # Path to the Windows Startup folder
    startup_dir = os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup")
    vbs_path = os.path.join(startup_dir, "StartBrowserAgentBridge.vbs")
    
    # VBScript content to run daemon.py windowless using pythonw.exe
    vbs_content = f'''Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "pythonw.exe \\"{daemon_path}\\"", 0, False
'''
    
    try:
        with open(vbs_path, "w") as f:
            f.write(vbs_content)
        print(f"[+] Successfully registered BrowserAgentBridge to launch on Windows startup!")
        print(f"    Startup Script: {vbs_path}")
        
        # Run it right now silently
        os.system(f'wscript.exe "{vbs_path}"')
        print(f"[+] Daemon started silently in the background.")
    except Exception as e:
        print(f"[-] Failed to register startup script: {e}")

if __name__ == "__main__":
    main()
