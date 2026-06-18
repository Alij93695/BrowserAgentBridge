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
1. Clone this repository locally.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `extension` folder in this repository.

### 2. Configure Permissions (Crucial)
To allow the extension to run silently in the background:
1. In `chrome://extensions/`, click **Details** on the `BrowserAgentBridge` card.
2. Under **Site access**, change the setting to **"On all sites"**. This ensures the extension can access background web tabs persistently without requiring manual activation clicks.

### 3. Start the Server
Navigate to the root directory and start the Python daemon:
```bash
python daemon.py
```
This launches a FastAPI server on `http://localhost:1313`. The extension will automatically connect to it via WebSockets.

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

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
