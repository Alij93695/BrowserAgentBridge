import requests
import json

DAEMON = "http://127.0.0.1:1313"

def cmd(action, params=None):
    res = requests.post(f"{DAEMON}/api/command", json={"action": action, "params": params or {}}, timeout=20)
    return res.json()

tabs = requests.get(f"{DAEMON}/api/tabs").json().get("tabs", [])
print("Tabs found:")
for t in tabs:
    print(f"[{t.get('id')}] {t.get('title')} -> {t.get('url')} (active={t.get('active')})")

github_tabs = [t for t in tabs if "github.com" in t.get("url", "")]
if github_tabs:
    gh_tab = github_tabs[0]
    print("\nReading GitHub tab content...")
    content = cmd("get_content", {"tab_id": gh_tab["id"]})
    text = content.get("result", {}).get("text", "") or content.get("data", {}).get("text", "") or str(content)
    print("GitHub Tab Content Preview (first 1000 chars):")
    print(text[:1000])
else:
    print("No GitHub tab found.")
