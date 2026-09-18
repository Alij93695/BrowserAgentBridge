# Privacy Policy for BrowserAgentBridge

**Last Updated: September 18, 2026**

BrowserAgentBridge ("we", "our", or "the extension") is committed to protecting your privacy. This Privacy Policy explains our practices regarding the collection, use, and disclosure of information through the BrowserAgentBridge Chrome Extension and associated local daemon.

---

## 1. Summary: 100% Local Execution

BrowserAgentBridge is a developer tool designed to bridge local AI agent frameworks (such as Python scripts, LangChain, CrewAI, AutoGPT) with Google Chrome. 

**We do not collect, store, transmit, or sell your personal data.** All communication occurs strictly on your local machine (`127.0.0.1` / `localhost`).

---

## 2. Information We Do NOT Collect

BrowserAgentBridge does NOT collect, transmit, or store on any external servers:
- Personally Identifiable Information (PII) such as your name, email, address, phone number, or age.
- Financial or payment information.
- Authentication credentials, passwords, or security keys.
- Personal communications, emails, chats, or text messages.
- Geolocation data or IP addresses.
- Browsing history, visited websites, or bookmarks.
- User activity tracking, mouse tracking, or keystroke logs outside of user-initiated local scripts.

---

## 3. How Data is Processed (Local Loopback Only)

- **Local WebSocket Bridge**: The extension communicates exclusively with a local Python daemon running on loopback address `ws://127.0.0.1:1313`. No traffic leaves your device.
- **On-Demand Automation**: The extension only reads page content or executes interactions on browser tabs when explicitly commanded by your own locally executed scripts.
- **Transient Memory**: Any extracted Markdown content or element metadata is transferred directly to your local Python process and is never persisted or uploaded by the extension.

---

## 4. Permissions & Justification

- **`tabs`**: Used strictly to identify, navigate, and manage specific browser tabs requested by your local scripts.
- **`scripting`**: Used to execute background DOM interactions (clicks, form filling) and extract page structure as Markdown on tabs you designate.
- **`webNavigation`**: Used to detect when a target page has completed loading before your local script proceeds.
- **`storage`**: Used solely to save local extension settings and preferences on your device.
- **`alarms`**: Used to keep the background service worker active and maintain healthy local WebSocket connections.
- **Host Permissions (`<all_urls>`)**: Required to allow developer automation across arbitrary web pages specified in your local automation scripts. No data from these sites is transmitted to external servers.

---

## 5. Third-Party Sharing and Data Selling

- We do not sell, rent, or trade your data to any third party.
- We do not share user data with advertising networks or data brokers.
- We do not use user data to determine creditworthiness or for lending purposes.

---

## 6. Open Source Transparency

BrowserAgentBridge is open source. You can inspect the entire codebase, including all background scripts and network operations, at:
**[https://github.com/Alij93695/BrowserAgentBridge](https://github.com/Alij93695/BrowserAgentBridge)**

---

## 7. Contact & Support

If you have questions or concerns regarding this Privacy Policy, please open an issue on our GitHub repository:
**[https://github.com/Alij93695/BrowserAgentBridge/issues](https://github.com/Alij93695/BrowserAgentBridge/issues)**
