"""
BrowserAgentBridge — Smart Form Filler Example
================================================
Demonstrates the smart form automation commands:
  fill_form, smart_fill, smart_click, press_key, clear_input

This script opens httpbin.org/forms/post in a background tab,
fills the form using human-readable field labels (no CSS selectors needed),
submits it, and reads the result — all without stealing browser focus.

Prerequisites:
  1. daemon.py is running on port 1313
  2. The Chrome extension is loaded and connected
  3. pip install requests
"""

import requests
import time
import json
import sys

DAEMON_URL = "http://127.0.0.1:1313"


def run_command(action, params=None, timeout=20.0):
    """Send a command to BrowserAgentBridge and return the result."""
    payload = {"action": action, "params": params or {}, "timeout": timeout}
    try:
        r = requests.post(f"{DAEMON_URL}/api/command", json=payload, timeout=30)
        data = r.json()
        if not data.get("success", False):
            print(f"  [WARN] Command '{action}' failed: {data.get('error', 'unknown')}")
        return data.get("result")
    except requests.ConnectionError:
        print("ERROR: Cannot connect to daemon. Is daemon.py running on port 1313?")
        sys.exit(1)


def main():
    print("=" * 60)
    print("  BrowserAgentBridge - Smart Form Filler Demo")
    print("=" * 60)

    # ------------------------------------------------------------------
    # 1. Check daemon is alive
    # ------------------------------------------------------------------
    try:
        status = requests.get(f"{DAEMON_URL}/api/status", timeout=5).json()
        if not status.get("connected"):
            print("ERROR: Extension is not connected. Open Chrome and check the extension.")
            sys.exit(1)
        print(f"\n[OK] Daemon connected - {status.get('tabs_count', '?')} tabs open")
    except requests.ConnectionError:
        print("ERROR: Cannot connect to daemon. Is daemon.py running on port 1313?")
        sys.exit(1)

    # ------------------------------------------------------------------
    # 2. Open httpbin form in a background tab
    # ------------------------------------------------------------------
    print("\n[1] Opening httpbin.org/forms/post in background tab...")
    tab_result = run_command("new_tab", {
        "url": "https://httpbin.org/forms/post",
        "active": False
    })
    tab_id = tab_result["id"]
    print(f"    Tab ID: {tab_id}")
    time.sleep(3)  # Wait for page to load

    # ------------------------------------------------------------------
    # 3. Fill the entire form with one command (fill_form)
    # ------------------------------------------------------------------
    print("\n[2] Filling form using fill_form (batch mode)...")
    fill_result = run_command("fill_form", {
        "tab_id": tab_id,
        "fields": {
            "Customer name": "Jane Doe",
            "Telephone": "+1-555-0199",
            "E-mail address": "jane.doe@example.com",
            "Size": "Medium",         # This is a select dropdown
            "Bacon": True,            # Checkbox
            "Extra cheese": True,     # Checkbox
            "Onion": False,           # Checkbox — leave unchecked
            "Delivery instructions": "Ring the doorbell twice, leave at the porch."
        },
        "submit": False  # Don't submit yet — we'll do it manually
    })
    print(f"    Result: {json.dumps(fill_result, indent=2)[:300]}")
    time.sleep(1)

    # ------------------------------------------------------------------
    # 4. Use clear_input to clear a field, then smart_fill to re-fill it
    # ------------------------------------------------------------------
    print("\n[3] Clearing 'Customer name' and re-filling with smart_fill...")
    run_command("clear_input", {
        "tab_id": tab_id,
        "target": "Customer name"
    })
    time.sleep(0.5)
    run_command("smart_fill", {
        "tab_id": tab_id,
        "target": "Customer name",
        "value": "John Smith"
    })
    print("    Re-filled Customer name -> 'John Smith'")

    # ------------------------------------------------------------------
    # 5. Press Tab key to move focus, then submit with smart_click
    # ------------------------------------------------------------------
    print("\n[4] Pressing Tab key, then clicking Submit via smart_click...")
    run_command("press_key", {
        "tab_id": tab_id,
        "key": "Tab"
    })
    time.sleep(0.5)
    run_command("smart_click", {
        "tab_id": tab_id,
        "target": "Submit"
    })
    time.sleep(3)  # Wait for form submission and page load

    # ------------------------------------------------------------------
    # 6. Read the submission result
    # ------------------------------------------------------------------
    print("\n[5] Reading submission result page...")
    content = run_command("get_content", {"tab_id": tab_id})
    if content:
        markdown = content.get("markdown", "")
        # Show first 800 chars
        print("    --- Result Page (first 800 chars) ---")
        for line in markdown[:800].split("\n"):
            print(f"    {line}")
    else:
        print("    [WARN] Could not retrieve page content")

    # ------------------------------------------------------------------
    # 7. Clean up
    # ------------------------------------------------------------------
    print(f"\n[6] Closing background tab {tab_id}...")
    run_command("close_tab", {"tab_id": tab_id})
    print("    Done!")

    print("\n" + "=" * 60)
    print("  Demo complete. All operations ran in the background.")
    print("=" * 60)


if __name__ == "__main__":
    main()
