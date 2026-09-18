# BrowserAgentBridge

`BrowserAgentBridge` is a lightweight, generic developer tool that bridges AI agents and LLMs with your Google Chrome browser. It enables agents to read pages, click elements, fill forms, and run browser scripts completely in the background, allowing you to continue your work undisturbed.

Unlike standard automation tools that steal screen focus or disrupt active browsing sessions, `BrowserAgentBridge` executes commands directly inside target background tabs (via Chrome MV3 extensions and WebSockets) without activating them.

---

## Features

- 🌐 **Silent Background Execution**: Open, navigate, read, and automate tabs without bringing them to the front or stealing focus.
- 🛠️ **Generic API**: Simple REST endpoints accessible by any programming language or agent framework (e.g., LangChain, CrewAI, AutoGPT, custom scripts).
- 📝 **Markdown Content Extraction**: Automatically converts HTML page structures into clean, semantic Markdown for LLM ingestion.
- ⚡ **No DevTools Protocol Overheads**: Runs natively inside standard Chrome using a lightweight service worker extension and a FastAPI server.

---

## Getting Started

### 1. Install the Chrome Extension
1. Clone this repository locally:
   ```bash
   git clone https://github.com/Alij93695/BrowserAgentBridge.git
   ```
2. Open Chrome (or Brave / Arc / Edge) and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension` folder in this repository.

### 2. Configure Permissions (Crucial)
To allow the extension to run silently in the background:
1. In `chrome://extensions/`, click **Details** on the `BrowserAgentBridge` card.
2. Under **Site access**, change the setting to **"On all sites"**. This ensures the extension can access background web tabs persistently without requiring manual activation clicks.

### 3. Start the Server

#### Prerequisites
Install required Python dependencies:
```bash
pip install fastapi uvicorn websockets pydantic
```

#### On macOS (MacBook):
- **Start in foreground**:
  ```bash
  python3 daemon.py
  ```
- **Start in background**:
  ```bash
  ./start_daemon.sh
  ```
- **Stop background daemon**:
  ```bash
  ./stop_daemon.sh
  ```
- **Auto-start on login (macOS LaunchAgent)**:
  ```bash
  python3 setup_autostart.py
  ```

#### On Windows:
- **Start in foreground**:
  ```bash
  python daemon.py
  ```
- **Auto-start on login / background**:
  ```bash
  python setup_autostart.py
  ```
- **Stop background daemon**:
  Double-click or run `stop_daemon.bat`.

Once started, the daemon listens on `http://127.0.0.1:1313`. The extension will automatically connect to it via WebSockets. You can view the live telemetry dashboard by opening `http://127.0.0.1:1313/` in your browser.

---

## REST API Reference

All requests to run browser commands are sent via HTTP POST to `http://localhost:1313/api/command`.

### 1. `GET /api/status`
Checks if the Chrome extension is connected to the daemon.
- **Response**:
  ```json
  {
    "connected": true,
    "tabs_count": 5,
    "last_screenshot_available": false
  }
  ```

### 2. `GET /api/tabs`
Lists all open tabs in the browser.
- **Response**:
  ```json
  {
    "connected": true,
    "tabs": [
      { "id": 12345, "title": "Inbox - Gmail", "url": "https://mail.google.com/...", "active": false },
      { "id": 67890, "title": "GitHub", "url": "https://github.com/", "active": true }
    ]
  }
  ```

### 3. `POST /api/command`
Executes a browser or page-level action.

#### Parameters:
- `action` (string): The command to run (see list below).
- `params` (object): Arguments for the action.
- `timeout` (float, optional): Seconds to wait before timing out. Defaults to `20.0`.

#### Standard Commands:
| Action | Parameter | Description |
| :--- | :--- | :--- |
| `new_tab` | `url` (str), `active` (bool, optional) | Opens a new tab. Set `active: false` to open it in the background. |
| `close_tab` | `tab_id` (int) | Closes the specified tab. |
| `select_tab`| `tab_id` (int) | Activates/brings the tab to the foreground. |
| `navigate`  | `url` (str), `tab_id` (int, optional) | Navigates the tab to a URL. |
| `get_content`| `tab_id` (int, optional) | Fetches the page content translated to Markdown and lists interactive elements. |
| `click`     | `selector` (str), `tab_id` (int, optional) | Simulates a click on a CSS selector, XPath, or text match. |
| `type`      | `selector` (str), `text` (str), `tab_id` (int, optional) | Types text into an input element. |
| `scroll`    | `direction` (str: `down`/`up`), `amount` (int), `tab_id` (int, optional) | Scrolls the page. |
| `wait`      | `selector` (str/int), `timeout` (int, optional), `tab_id` (int, optional) | Waits for an element to appear, or pauses for `timeout` milliseconds. |
| `execute`   | `code` (str), `tab_id` (int, optional) | Runs arbitrary JavaScript inside the tab context. |

#### Smart Form Commands (v1.1.0+):
| Action | Parameter | Description |
| :--- | :--- | :--- |
| `fill_form` | `fields` (object), `submit` (bool, optional), `tab_id` (int, optional) | Fill multiple form fields at once using human-readable labels. Fields is a `{label: value}` map. Checkboxes accept `true`/`false`. Set `submit: true` to auto-submit. |
| `smart_fill`| `target` (str), `value` (str/bool), `tab_id` (int, optional) | Fill a single field by its visible label, placeholder, or aria-label. No CSS selector needed. |
| `smart_click` | `target` (str), `tab_id` (int, optional) | Click a button, link, or element by its visible text. Uses full mouse event sequence (mousedown → mouseup → click). |
| `press_key` | `key` (str), `modifiers` (array, optional), `tab_id` (int, optional) | Dispatch a keyboard event. `key` uses [KeyboardEvent.key](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/key) values (e.g., `"Enter"`, `"Tab"`, `"a"`). `modifiers` can include `"ctrl"`, `"shift"`, `"alt"`, `"meta"`. |
| `clear_input` | `target` (str), `tab_id` (int, optional) | Clear any input field by its visible label, placeholder, or CSS selector. |

---

## Python Background Automation Example

The following script opens a tab in the background, navigates to Google, conducts a search, and reads the results without ever interrupting the user's active window or tab.

```python
import requests
import time

DAEMON_URL = "http://127.0.0.1:1313"

def run_command(action, params={}):
    r = requests.post(f"{DAEMON_URL}/api/command", json={"action": action, "params": params})
    return r.json().get("result")

# 1. Open Google silently in the background
new_tab_res = run_command("new_tab", {"url": "https://www.google.com", "active": False})
tab_id = new_tab_res["id"]
print(f"Created background Tab ID: {tab_id}")

# Wait for page load
time.sleep(2)

# 2. Type search query in the background tab
run_command("type", {
    "tab_id": tab_id,
    "selector": '[name="q"]',
    "text": "GitHub BrowserAgentBridge"
})

# 3. Click search button in the background tab
run_command("click", {
    "tab_id": tab_id,
    "selector": 'input[value="Google Search"]'
})

# Wait for search results
time.sleep(3)

# 4. Fetch the search results markdown from the background tab
page_data = run_command("get_content", {"tab_id": tab_id})
print("\n--- Search Results Markdown ---")
print(page_data.get("markdown")[:1000]) # First 1000 characters

# 5. Clean up by closing the background tab
run_command("close_tab", {"tab_id": tab_id})
print("Background tab closed.")
```

---

## Smart Form Automation Example

The smart form commands let you fill forms using **visible field labels** instead of CSS selectors — just like a human would. See [`example_form_filler.py`](example_form_filler.py) for a complete runnable demo.

Quick example using `curl`:

```bash
# Fill multiple fields at once
curl -X POST http://localhost:1313/api/command \
  -H "Content-Type: application/json" \
  -d '{
    "action": "fill_form",
    "params": {
      "fields": {
        "First Name": "Jane",
        "Last Name": "Doe",
        "Email": "jane@example.com",
        "Subscribe": true
      },
      "submit": true
    }
  }'

# Click a button by its visible text
curl -X POST http://localhost:1313/api/command \
  -H "Content-Type: application/json" \
  -d '{"action": "smart_click", "params": {"target": "Sign Up"}}'

# Fill a single field by label
curl -X POST http://localhost:1313/api/command \
  -H "Content-Type: application/json" \
  -d '{"action": "smart_fill", "params": {"target": "Password", "value": "s3cret"}}'
```

Run the full demo:
```bash
python example_form_filler.py
```

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
