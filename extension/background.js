// BrowserAgentBridge - Extension Background Service Worker
const WS_URL = 'ws://127.0.0.1:1313/ws';
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000; // Start with 5s delay
const MAX_RECONNECT_DELAY = 10000; // Cap at 10 seconds for fast reconnection
let targetTabId = null;

// --- Screenshot Rate Limiter ---
// Chrome enforces MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND (~2/sec).
// We debounce and queue screenshot requests to stay well within the limit.
let lastScreenshotTime = 0;
const SCREENSHOT_MIN_INTERVAL_MS = 1000; // At most 1 screenshot per second
let pendingScreenshotResolvers = [];
let screenshotInFlight = false;

async function throttledScreenshot() {
  const now = Date.now();
  const elapsed = now - lastScreenshotTime;

  if (screenshotInFlight) {
    // Already capturing — queue this request and resolve it with the same result
    return new Promise((resolve) => {
      pendingScreenshotResolvers.push(resolve);
    });
  }

  if (elapsed < SCREENSHOT_MIN_INTERVAL_MS) {
    // Too soon — wait then capture
    const waitMs = SCREENSHOT_MIN_INTERVAL_MS - elapsed;
    await new Promise(r => setTimeout(r, waitMs));
  }

  screenshotInFlight = true;
  try {
    const result = await _captureScreenshot();
    // Resolve any queued callers with the same result
    for (const resolver of pendingScreenshotResolvers) {
      try { resolver(result); } catch (e) {}
    }
    pendingScreenshotResolvers = [];
    return result;
  } catch (err) {
    const fallback = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    for (const resolver of pendingScreenshotResolvers) {
      try { resolver(fallback); } catch (e) {}
    }
    pendingScreenshotResolvers = [];
    return fallback;
  } finally {
    lastScreenshotTime = Date.now();
    screenshotInFlight = false;
  }
}

async function _captureScreenshot() {
  try {
    const tab = await getTargetTab();
    if (!tab) throw new Error('No target tab found');

    // Guard: Do not attempt to capture screenshots on internal/restricted tabs
    if (!isScriptableUrl(tab.url)) {
      return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
    return dataUrl;
  } catch (err) {
    // Only log warning if it is not a known/expected permission error to keep console clean
    const msg = err.message || '';
    if (!msg.includes('activeTab') && !msg.includes('permission') && !msg.includes('Cannot access') && !msg.includes('not allowed')) {
      console.warn('Screenshot capture failed:', msg);
    }
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  }
}

// --- Remote & Local Logging System ---
function extLog(level, msg) {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] ${msg}`;
  console.log('BrowserAgentBridge:', formatted);
  
  chrome.storage.local.get(['extLogs'], (res) => {
    const logs = (res && res.extLogs) ? res.extLogs : [];
    logs.push(formatted);
    if (logs.length > 50) logs.shift();
    chrome.storage.local.set({ extLogs: logs });
  });

  try {
    fetch('http://127.0.0.1:1313/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: level, message: msg })
    }).catch(() => {});
  } catch (e) {
    // Ignore fetch errors
  }
}

const WS_URLS = ['ws://127.0.0.1:1313/ws', 'ws://localhost:1313/ws'];
let wsIndex = 0;

function shouldConnect() {
  return !ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return; // Already connecting or connected
  }

  const targetUrl = WS_URLS[wsIndex % WS_URLS.length];
  extLog('info', 'Attempting WebSocket connection to ' + targetUrl);
  reconnectDelay = 2000; // Reset backoff on explicit connect attempt
  // Clean up any existing closed connection
  if (ws) {
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }

  try {
    ws = new WebSocket(targetUrl);
  } catch (err) {
    extLog('error', 'WebSocket constructor failed: ' + err.message);
    wsIndex++;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    extLog('info', 'WebSocket Connected successfully to Daemon at ' + targetUrl);
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectDelay = 3000; // Reset backoff on successful connect
    chrome.storage.local.set({ connected: true });
    sendToDaemon({ type: 'status', status: 'connected' });
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      const { id, action, params } = message;

      if (!action) return;

      try {
        const result = await handleCommand(action, params);
        sendToDaemon({ id, success: true, result });
      } catch (err) {
        extLog('error', 'Error executing command ' + action + ': ' + err.message);
        sendToDaemon({ id, success: false, error: err.message });
      }
    } catch (err) {
      extLog('error', 'Error parsing daemon message: ' + err.message);
    }
  };

  ws.onclose = (evt) => {
    extLog('warn', 'WebSocket connection closed (code: ' + (evt ? evt.code : 'unknown') + ')');
    chrome.storage.local.set({ connected: false });
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    extLog('error', 'WebSocket error event triggered');
    chrome.storage.local.set({ connected: false });
    stopHeartbeat();
    scheduleReconnect();
  };
}

let heartbeatTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendToDaemon({ type: 'heartbeat' });
    } else {
      stopHeartbeat();
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Register Service Worker lifecycle event listeners
chrome.runtime.onInstalled.addListener(() => {
  extLog('info', 'Extension Installed/Reloaded lifecycle event');
  try {
    chrome.alarms.create('checkConnection', { periodInMinutes: 1 });
  } catch (e) {
    console.warn('Alarm creation error:', e);
  }
  if (shouldConnect()) connect();
});

chrome.runtime.onStartup.addListener(() => {
  extLog('info', 'Extension Startup lifecycle event');
  if (shouldConnect()) connect();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkConnection') {
    if (shouldConnect()) {
      extLog('info', 'Connection check alarm fired. Triggering connect...');
      connect();
    }
  }
});

// Wake up and connect on navigation and tab events (to ensure fast connection when active)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) { // Only main frame navigations
    if (shouldConnect()) {
      extLog('info', 'WebNavigation committed event. Triggering connect...');
      connect();
    }
  }
});

chrome.tabs.onActivated.addListener(() => {
  if (shouldConnect()) {
    extLog('info', 'Tab activated event. Triggering connect...');
    connect();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    if (shouldConnect()) {
      extLog('info', 'Tab updated event. Triggering connect...');
      connect();
    }
  }
});

// Safe deferred initial connection after top-level script evaluation completes
setTimeout(() => {
  connect();
}, 100);

// --- Command Handler Router ---

async function handleCommand(action, params = {}) {
  const tabId = params.tab_id || params.tabId || null;
  switch (action) {
    case 'list_tabs':
      return await listTabs();
    case 'new_tab':
      return await newTab(params.url, params.active !== false);
    case 'select_tab':
      return await selectTab(params.tab_id);
    case 'close_tab':
      return await closeTab(params.tab_id);
    case 'screenshot':
      return await throttledScreenshot(); // Rate-limited!
    case 'navigate':
      return await navigate(params.url, tabId);

    // Page-level actions that run scripts inside the tab
    case 'get_content':
      const contentRes = await runInTab(getContentInTab, [], tabId);
      let actualTabId = tabId;
      if (!actualTabId) {
        const resolvedTab = await getTargetTab();
        if (resolvedTab) actualTabId = resolvedTab.id;
      }
      if (contentRes && typeof contentRes === 'object') {
        contentRes.tab_id = actualTabId;
      }
      return contentRes;
    case 'click_manage_by_index':
      return await runInTab((idx) => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const manageButtons = buttons.filter(b => b.innerText.trim() === 'Manage');
        if (idx < manageButtons.length) {
          const el = manageButtons[idx];
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.click();
          return { success: true };
        }
        return { success: false, error: `Index ${idx} out of range (found ${manageButtons.length})` };
      }, [params.index], tabId);
    case 'get_app_access_details':
      return await runInTab(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const info = inputs.map((inp, idx) => ({
          idx,
          id: inp.id,
          type: inp.type,
          checked: inp.checked,
          value: inp.value,
          label: inp.nextElementSibling ? inp.nextElementSibling.innerText : ''
        }));
        const text = document.body.innerText;
        return { inputs: info, textSnippet: text.slice(0, 1000) };
      }, [], tabId);
    case 'inspect_inputs_detailed':
      return await runInTab(() => {
        const elements = Array.from(document.querySelectorAll('input, textarea'));
        return elements.map((el, idx) => {
          const rect = el.getBoundingClientRect();
          return {
            idx,
            tag: el.tagName.toLowerCase(),
            type: el.type || '',
            id: el.id,
            className: el.className,
            placeholder: el.placeholder || '',
            value: el.value || '',
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0
          };
        });
      }, [], tabId);
    case 'select_yes_radio':
      return await runInTab(() => {
        const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
        if (radios.length > 0) {
          const yesRadio = radios[0];
          yesRadio.click();
          yesRadio.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
          yesRadio.dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
          return { success: true };
        }
        return { success: false, error: 'No radios found' };
      }, [], tabId);
    case 'fill_app_access_inputs':
      return await runInTab((name, username, password, extraInfo) => {
        const textInputs = Array.from(document.querySelectorAll('input.mdc-text-field__input'));
        if (textInputs.length < 3) {
          return { success: false, error: `Only found ${textInputs.length} text inputs` };
        }
        textInputs[0].value = name;
        textInputs[0].dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
        textInputs[0].dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        
        textInputs[1].value = username;
        textInputs[1].dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
        textInputs[1].dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        
        textInputs[2].value = password;
        textInputs[2].dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
        textInputs[2].dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        
        const textarea = document.querySelector('textarea.mdc-text-field__input');
        if (textarea) {
          textarea.value = extraInfo;
          textarea.dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
          textarea.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        }
        
        const checkbox = document.querySelector('input.mdc-checkbox__native-control, input[type="checkbox"]');
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          checkbox.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        }
        
        const buttons = Array.from(document.querySelectorAll('button'));
        const addButton = buttons.find(b => b.innerText.trim() === 'Add');
        if (addButton) {
          addButton.click();
          return { success: true, clickedAdd: true };
        }
        return { success: false, error: 'Add button not found' };
      }, [params.name, params.username, params.password, params.extraInfo], tabId);
    case 'click':
      return await runInTab(clickElementInTab, [params.selector], tabId);
    case 'type':
      return await runInTab(typeTextInTab, [params.selector, params.text], tabId);
    case 'scroll':
      return await runInTab(scrollInTab, [params.direction, params.amount], tabId);
    case 'wait':
      return await runInTab(waitInTab, [params.selector, params.timeout], tabId);
    case 'execute':
      return await runInTab(executeRawJs, [params.code], tabId, params.world || 'ISOLATED');
    case 'check_extension_ai':
      return {
        hasChrome: typeof chrome !== 'undefined',
        hasAiOriginTrial: typeof chrome !== 'undefined' && typeof chrome.aiOriginTrial !== 'undefined',
        aiOriginTrialProps: typeof chrome !== 'undefined' && chrome.aiOriginTrial ? Object.keys(chrome.aiOriginTrial) : null,
        hasAi: typeof ai !== 'undefined',
        hasWindowAi: typeof window !== 'undefined' && typeof window.ai !== 'undefined'
      };
    case 'gmail_search':
      return await runInTab(gmailSearchInTab, [params.query], tabId);

    case 'reload_extension':
      chrome.runtime.reload();
      return { success: true };

    case 'promote_to_production_action':
      return await runInTab(findAndClickProductionInTab, [], tabId);

    case 'dump_dropdown_html':
      return await runInTab(() => {
        const results = [];
        const all = Array.from(document.querySelectorAll('*'));
        for (let el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.left > 1000 && rect.top > 400 && rect.top < 700) {
            results.push({
              tag: el.tagName,
              id: el.id,
              class: el.className,
              text: el.innerText ? el.innerText.trim().slice(0, 50) : '',
              outer: el.outerHTML.slice(0, 150)
            });
          }
        }
        return results;
      }, [], tabId);

    case 'smart_fill': {
      const field = params.target || params.field;
      const res = await runInTab(fillFormInTab, [{ [field]: params.value }, false], tabId);
      if (res && res.fields && res.fields[field]) {
        return res.fields[field];
      }
      return res;
    }

    case 'fill_form':
      return await runInTab(fillFormInTab, [params.fields, params.submit || false, params.submitLabel || 'submit'], tabId);

    case 'smart_click':
      return await runInTab(smartClickInTab, [params.target, params.role || null], tabId);

    case 'press_key':
      return await runInTab(pressKeyInTab, [params.key, params.selector || null, params.modifiers || []], tabId);

    case 'clear_input': {
      const field = params.target || params.selector || params.field;
      const res = await runInTab(fillFormInTab, [{ [field]: '' }, false], tabId);
      if (res && res.fields && res.fields[field]) {
        return res.fields[field];
      }
      return res;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// --- Browser-Level Commands ---

async function listTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    if (!tabs || !Array.isArray(tabs)) return [];
    return tabs.map(t => ({
      id: t.id,
      title: t.title || 'Untitled',
      url: t.url || '',
      active: !!t.active,
      favIconUrl: t.favIconUrl || ''
    }));
  } catch (err) {
    extLog('warn', 'listTabs query warning: ' + err.message);
    return [];
  }
}

async function newTab(url = 'https://www.google.com', active = true) {
  try {
    const tab = await chrome.tabs.create({ url, active });
    targetTabId = tab.id;
    return { id: tab.id, title: tab.title, url: tab.url };
  } catch (err) {
    extLog('warn', 'newTab tabs.create caught: ' + (err ? (err.message || String(err)) : 'unknown'));
    try {
      const win = await chrome.windows.create({ url, focused: active });
      const tab = (win.tabs && win.tabs[0]) || null;
      if (tab) targetTabId = tab.id;
      return { id: tab ? tab.id : win.id, title: tab ? tab.title : '', url };
    } catch (winErr) {
      extLog('error', 'windows.create failed: ' + (winErr ? (winErr.message || String(winErr)) : 'unknown'));
      throw winErr;
    }
  }
}

async function selectTab(tabId) {
  try {
    const parsedId = parseInt(tabId);
    if (isNaN(parsedId)) throw new Error(`Invalid tab ID: ${tabId}`);
    const tab = await chrome.tabs.update(parsedId, { active: true });
    targetTabId = parsedId;
    if (tab && tab.windowId) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch (wErr) { /* ignore window focus errors */ }
    }
    return { id: tab ? tab.id : parsedId, title: tab ? tab.title : '', url: tab ? tab.url : '' };
  } catch (err) {
    throw new Error(`Failed to select tab ${tabId}: ${err.message}`);
  }
}

async function closeTab(tabId) {
  try {
    const parsedId = parseInt(tabId);
    if (isNaN(parsedId)) throw new Error(`Invalid tab ID: ${tabId}`);
    await chrome.tabs.remove(parsedId);
    if (targetTabId === parsedId) {
      targetTabId = null;
    }
    return { success: true };
  } catch (err) {
    throw new Error(`Failed to close tab ${tabId}: ${err.message}`);
  }
}

async function captureScreenshot() {
  // Public API entry — delegates to throttled version
  return await throttledScreenshot();
}

async function navigate(url, tabId = null) {
  let tab = null;
  if (tabId !== null && tabId !== undefined) {
    const parsedId = parseInt(tabId);
    if (!isNaN(parsedId)) {
      try {
        tab = await chrome.tabs.get(parsedId);
      } catch (e) {
        console.warn(`Tab ID ${parsedId} not found for navigate, falling back.`);
      }
    }
  }
  if (!tab) {
    tab = await getTargetTab();
  }
  if (!tab) throw new Error('No target tab found');

  // Ensure protocol is present
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // Detect hash-only navigation to avoid waiting for page reload status 'complete'
  const currentUrl = tab.url;
  const currentBase = currentUrl ? currentUrl.split('#')[0] : '';
  const newBase = url.split('#')[0];

  if (currentBase === newBase && currentUrl !== url) {
    await chrome.tabs.update(tab.id, { url });
    return { id: tab.id, url, status: 'hashchange' };
  }

  return new Promise((resolve, reject) => {
    let completed = false;

    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ id: tab.id, url, status: 'timeout' });
      }
    }, 15000);

    function listener(tId, changeInfo) {
      if (tId === tab.id && changeInfo.status === 'complete') {
        completed = true;
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ id: tab.id, url, status: 'complete' });
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tab.id, { url }).catch(err => {
      completed = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      reject(err);
    });
  });
}

// --- Helper to execute code in active tab ---

function isWebUrl(url) {
  return url && (url.startsWith('http://') || url.startsWith('https://'));
}

function isScriptableUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    // Only http, https, and file schemes are allowed
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    // Block Chrome Web Store entirely (Chrome security model blocks executeScript across all store URLs), Edge Add-ons, and local browser pages
    if (host === 'chromewebstore.google.com' || 
        (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) ||
        (host === 'edge.microsoft.com' && parsed.pathname.startsWith('/addons'))) {
      return false;
    }
    return true;
  } catch (e) {
    // If URL parsing fails, check startsWith prefixes as fallback
    const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://', 'view-source:'];
    for (const prefix of blocked) {
      if (url.startsWith(prefix)) return false;
    }
    return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
  }
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true });
  }
  return tabs[0];
}

async function getActiveWebTab() {
  // 1. Try active tab in last focused window
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length > 0 && isScriptableUrl(tabs[0].url)) return tabs[0];

  // 2. Try active tab in current window
  tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && isScriptableUrl(tabs[0].url)) return tabs[0];

  // 3. Try active tab in any window
  tabs = await chrome.tabs.query({ active: true });
  const activeWebTabs = tabs.filter(t => isScriptableUrl(t.url));
  if (activeWebTabs.length > 0) return activeWebTabs[0];

  // 4. Try any web tab at all
  tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter(t => isScriptableUrl(t.url));
  if (webTabs.length > 0) return webTabs[0];

  // 5. Fallback to active tab in last focused window
  return await getActiveTab();
}

async function getTargetTab() {
  if (targetTabId !== null) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab) return tab;
    } catch (err) {
      targetTabId = null;
    }
  }
  return await getActiveWebTab();
}

async function runInTab(func, args = [], tabId = null, world = 'ISOLATED') {
  let tab = null;
  if (tabId !== null && tabId !== undefined) {
    const parsedId = parseInt(tabId);
    if (!isNaN(parsedId)) {
      try {
        tab = await chrome.tabs.get(parsedId);
      } catch (e) {
        console.warn(`Tab ID ${parsedId} not found, falling back to target tab.`);
      }
    }
  }
  if (!tab) {
    tab = await getTargetTab();
  }
  if (!tab) throw new Error('No target tab found');

  // Guard: Cannot script on non-web pages (chrome://, edge://, about:, devtools://)
  if (!isScriptableUrl(tab.url)) {
    throw new Error(`Cannot run browser automation on internal browser page: ${tab.url || 'empty'}. Switch to a regular web page first.`);
  }

  // Guard: Wait for tab to finish loading if it's still in 'loading' state
  if (tab.status === 'loading') {
    await new Promise((resolve) => {
      let resolved = false;
      function cleanup() {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timeout);
          resolve();
        }
      }
      const timeout = setTimeout(cleanup, 8000); // Safety timeout
      function onUpdated(tId, changeInfo) {
        if (tId === tab.id && changeInfo.status === 'complete') {
          cleanup();
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    // Re-fetch tab info after load
    try {
      tab = await chrome.tabs.get(tab.id);
    } catch (e) {
      throw new Error('Tab closed while waiting for it to load');
    }
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: func,
      args: args,
      world: world
    });

    if (!results || results.length === 0) {
      throw new Error('Script execution returned no results');
    }

    return results[0].result;
  } catch (err) {
    const errMsg = err.message || '';
    if (errMsg.includes('activeTab') || errMsg.includes('Cannot access') || errMsg.includes('permission') || errMsg.includes('not allowed')) {
      throw new Error(
        `Permission denied for tab ${tab.id} (${tab.url}). ` +
        `Make sure the extension has "All sites" access: right-click the extension icon → "This can read and change site data" → "On all sites".`
      );
    }
    throw err;
  }
}

// --- Injectable Content Functions ---
// Note: These run in the context of the target web page, so they cannot access extension APIs, only standard DOM.

function executeRawJs(code) {
  try {
    const val = eval(code);
    if (val === undefined) return JSON.stringify({ result: 'undefined' });
    return typeof val === 'string' ? val : JSON.stringify(val);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

function getContentInTab() {
  try {
    const title = document.title;
    const url = window.location.href;

    if (!document.body) {
      return {
        title,
        url,
        markdown: "Page body not loaded yet.",
        interactive_elements: []
      };
    }

    function cleanText(str) {
      return str.replace(/\s+/g, ' ').trim();
    }

    function getElementSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.name) return `[name="${el.name}"]`;

      let selector = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const firstClass = el.className.split(' ')[0];
        if (firstClass && !firstClass.includes(':')) {
          selector += `.${firstClass}`;
        }
      }

      if (el.placeholder) {
        selector += `[placeholder="${el.placeholder}"]`;
      }

      return selector;
    }

    const interactiveElements = [];

    const inputs = document.querySelectorAll('input, textarea, select, button, a');
    inputs.forEach((el, index) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;

      const selector = getElementSelector(el);
      const text = cleanText(el.innerText || el.value || el.placeholder || '');

      let type = 'element';
      if (el.tagName === 'A') type = 'link';
      else if (el.tagName === 'BUTTON' || el.type === 'button' || el.type === 'submit') type = 'button';
      else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') type = 'input';
      else if (el.tagName === 'SELECT') type = 'select';

      const label = text ? `"${text}"` : (el.placeholder ? `placeholder "${el.placeholder}"` : `element ${index}`);

      interactiveElements.push({
        type,
        text,
        placeholder: el.placeholder || '',
        selector,
        label,
        href: el.tagName === 'A' ? el.href : '',
        rect: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    });

    let markdown = '';
    function traverse(node) {
      if (node.nodeType === 3) {
        const text = cleanText(node.textContent);
        if (text) markdown += text + ' ';
        return;
      }

      if (node.nodeType !== 1) return;

      const tagName = node.tagName.toLowerCase();
      const style = window.getComputedStyle(node);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
      if (tagName === 'script' || tagName === 'style' || tagName === 'noscript' || tagName === 'iframe') return;

      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        const level = tagName[1];
        markdown += '\n\n' + '#'.repeat(level) + ' ';
        for (let child of node.childNodes) traverse(child);
        markdown += '\n\n';
      } else if (tagName === 'p') {
        markdown += '\n\n';
        for (let child of node.childNodes) traverse(child);
        markdown += '\n\n';
      } else if (tagName === 'br') {
        markdown += '\n';
      } else if (tagName === 'li') {
        markdown += '\n- ';
        for (let child of node.childNodes) traverse(child);
      } else if (tagName === 'a') {
        const linkText = cleanText(node.innerText);
        if (linkText) {
          markdown += ` [${linkText}] `;
        }
      } else if (tagName === 'input' || tagName === 'textarea') {
        const placeholder = node.placeholder ? ` (${node.placeholder})` : '';
        const val = node.value ? ` [value: ${node.value}]` : '';
        markdown += ` [Input: ${getElementSelector(node)}${placeholder}${val}] `;
      } else if (tagName === 'button') {
        const btnText = cleanText(node.innerText);
        markdown += ` [Button: "${btnText}" (${getElementSelector(node)})] `;
      } else {
        for (let child of node.childNodes) traverse(child);
      }
    }

    traverse(document.body);

    markdown = markdown.replace(/\n\s+\n/g, '\n\n').replace(/ +/g, ' ').trim();

    const identityElements = [];
    try {
      function findTextNodes(node, searchText, results) {
        if (!node) return;
        if (node.nodeType === 3 && node.textContent && node.textContent.includes(searchText)) {
          if (node.parentNode) {
            results.push({
              tagName: node.parentNode.tagName,
              className: node.parentNode.className,
              outerHTML: node.parentNode.outerHTML.slice(0, 150)
            });
          }
        }
        if (node.childNodes) {
          for (let child of node.childNodes) {
            findTextNodes(child, searchText, results);
          }
        }
        if (node.shadowRoot) {
          for (let child of node.shadowRoot.childNodes) {
            findTextNodes(child, searchText, results);
          }
        }
      }
      findTextNodes(document.body, 'Identity info', identityElements);
    } catch(e) {}

    return {
      title,
      url,
      markdown,
      interactive_elements: interactiveElements,
      identity_elements: identityElements
    };
  } catch (err) {
    return {
      title: document.title || "Unknown Page",
      url: window.location.href || "unknown",
      markdown: "Exception in content extraction: " + err.message,
      interactive_elements: []
    };
  }
}

function clickElementInTab(selector) {
  try {
    let el = null;

    if (selector.startsWith('//') || selector.startsWith('((')) {
      const result = document.evaluate(selector, document, null, 9, null);
      el = result.singleNodeValue;
    } else {
      try {
        el = document.querySelector(selector);
      } catch (e) { /* invalid selector, fall through */ }

      if (!el) {
        const query = selector.toLowerCase().replace(/['"]/g, '').trim();
        const rows = document.querySelectorAll('tr, [role="row"]');
        for (let row of rows) {
          if (row.innerText && row.innerText.toLowerCase().includes(query)) {
            el = row;
            break;
          }
        }
      }

      if (!el) {
        const query = selector.toLowerCase().replace(/['"]/g, '').trim();
        const clickables = document.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]');
        for (let item of clickables) {
          if (item.innerText.toLowerCase().includes(query) || (item.value && item.value.toLowerCase().includes(query))) {
            el = item;
            break;
          }
        }
      }

      if (!el) {
        const inputs = document.querySelectorAll('input, textarea');
        for (let item of inputs) {
          if (item.placeholder && item.placeholder.toLowerCase().includes(selector.toLowerCase())) {
            el = item;
            break;
          }
        }
      }

      if (!el) {
        const allElements = document.querySelectorAll('*');
        for (let item of allElements) {
          if (item.innerText && item.innerText.includes(selector)) {
            const rect = item.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              let hasChildWithText = false;
              for (let child of item.children) {
                if (child.innerText && child.innerText.includes(selector)) {
                  hasChildWithText = true;
                  break;
                }
              }
              if (!hasChildWithText) {
                el = item;
                break;
              }
            }
          }
        }
      }
    }

    if (!el) {
      throw new Error(`Element not found matching selector or text: "${selector}"`);
    }

    const originalStyle = el.getAttribute('style') || '';
    el.style.outline = '3px solid #7c3aed';
    el.style.outlineOffset = '2px';
    el.style.transition = 'outline 0.3s ease';

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    setTimeout(() => {
      el.setAttribute('style', originalStyle);
    }, 1000);

    const mouseOverEvent = new (globalThis.MouseEvent || globalThis.Event)('mouseover', { bubbles: true, cancelable: true });
    const mouseDownEvent = new (globalThis.MouseEvent || globalThis.Event)('mousedown', { bubbles: true, cancelable: true });
    const mouseUpEvent = new (globalThis.MouseEvent || globalThis.Event)('mouseup', { bubbles: true, cancelable: true });
    const clickEvent = new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true, cancelable: true });

    el.dispatchEvent(mouseOverEvent);
    el.dispatchEvent(mouseDownEvent);
    el.focus();
    el.dispatchEvent(mouseUpEvent);
    el.dispatchEvent(clickEvent);

    return { success: true, element: el.tagName.toLowerCase(), selector };
  } catch (err) {
    return { success: false, error: err.message, selector };
  }
}

function typeTextInTab(selector, text) {
  try {
    let el = null;
    if (selector.startsWith('//') || selector.startsWith('((')) {
      const result = document.evaluate(selector, document, null, 9, null);
      el = result.singleNodeValue;
    } else {
      try {
        el = document.querySelector(selector);
      } catch (e) {}
    }

    if (!el) {
      const inputs = document.querySelectorAll('input, textarea');
      for (let item of inputs) {
        if (item.placeholder && item.placeholder.toLowerCase().includes(selector.toLowerCase())) {
          el = item;
          break;
        }
        if (item.name && item.name.toLowerCase() === selector.toLowerCase()) {
          el = item;
          break;
        }
      }
    }

    if (!el) {
      throw new Error(`Input element not found matching: "${selector}"`);
    }

    const originalStyle = el.getAttribute('style') || '';
    el.style.outline = '3px solid #06b6d4';
    el.style.outlineOffset = '2px';

    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus();

    el.value = '';

    let currentVal = '';
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      currentVal += char;

      const keydown = new (globalThis.KeyboardEvent || globalThis.Event)('keydown', { key: char, charCode: char.charCodeAt(0), bubbles: true });
      const keypress = new (globalThis.KeyboardEvent || globalThis.Event)('keypress', { key: char, charCode: char.charCodeAt(0), bubbles: true });

      el.dispatchEvent(keydown);
      el.dispatchEvent(keypress);

      const proto = el.tagName.toLowerCase() === 'textarea' 
        ? (globalThis.HTMLTextAreaElement ? globalThis.HTMLTextAreaElement.prototype : null) 
        : (globalThis.HTMLInputElement ? globalThis.HTMLInputElement.prototype : null);
      const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, currentVal);
      } else {
        el.value = currentVal;
      }

      const inputEvent = new (globalThis.Event || Object)('input', { bubbles: true });
      el.dispatchEvent(inputEvent);

      const keyup = new (globalThis.KeyboardEvent || globalThis.Event)('keyup', { key: char, charCode: char.charCodeAt(0), bubbles: true });
      el.dispatchEvent(keyup);
    }

    const changeEvent = new (globalThis.Event || Object)('change', { bubbles: true });
    el.dispatchEvent(changeEvent);

    setTimeout(() => {
      el.setAttribute('style', originalStyle);
    }, 1000);

    return { success: true, textLength: text.length, selector };
  } catch (err) {
    return { success: false, error: err.message, selector };
  }
}

function scrollInTab(direction, amount) {
  let scrollAmount = parseInt(amount) || 400;
  if (direction === 'down') {
    window.scrollBy({ top: scrollAmount, left: 0, behavior: 'smooth' });
  } else if (direction === 'up') {
    window.scrollBy({ top: -scrollAmount, left: 0, behavior: 'smooth' });
  } else if (direction === 'bottom') {
    window.scrollTo({ top: document.body.scrollHeight, left: 0, behavior: 'smooth' });
  } else if (direction === 'top') {
    window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
  }
  return { success: true, direction, scrollY: window.scrollY };
}

function waitInTab(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const delay = parseInt(selector);
    if (!isNaN(delay) && String(delay) === String(selector)) {
      setTimeout(() => {
        resolve({ success: true, waited: delay });
      }, delay);
      return;
    }

    const start = Date.now();
    const interval = setInterval(() => {
      let el = null;
      try {
        el = document.querySelector(selector);
      } catch (e) {
        // Invalid selector syntax
      }
      if (el) {
        clearInterval(interval);
        resolve({ success: true, found: selector, elapsed: Date.now() - start });
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for selector: "${selector}"`));
      }
    }, 250);
  });
}

function gmailSearchInTab(query) {
  try {
    const q = document.querySelector('input[name="q"]');
    if (!q) throw new Error('Search input not found');

    q.focus();
    q.value = query;

    q.dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
    q.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));

    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    q.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keydown', keyOpts));
    q.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keypress', keyOpts));
    q.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keyup', keyOpts));

    const form = q.closest('form');
    if (form) {
      const searchBtn = form.querySelector('button[aria-label="Search mail"]') || form.querySelector('button') || document.querySelector('button.gb_1e');
      if (searchBtn) {
        searchBtn.click();
      }
    }
    return { success: true, query };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function findAndClickProductionInTab() {
  try {
    // 1. Click Promote release button
    let promoteBtn = null;
    const buttons = Array.from(document.querySelectorAll('button'));
    for (let btn of buttons) {
      if (btn.innerText && btn.innerText.includes('Promote release')) {
        promoteBtn = btn;
        break;
      }
    }
    if (!promoteBtn) {
      return { success: false, error: 'Promote release button not found' };
    }
    
    promoteBtn.scrollIntoView({ block: 'center' });
    promoteBtn.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseover', { bubbles: true }));
    promoteBtn.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mousedown', { bubbles: true }));
    promoteBtn.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseup', { bubbles: true }));
    promoteBtn.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true }));
    
    // 2. Wait 1 second for the dropdown menu to render
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 3. Find the Production dropdown option
    // It has text "Production" and is on the right side of the screen (x > 500)
    let targetOption = null;
    const all = Array.from(document.querySelectorAll('*'));
    for (let el of all) {
      if (el.innerText && el.innerText.trim().startsWith('Production')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.left > 500) {
          // Leaf node matching Production
          let hasChild = false;
          for (let child of el.children) {
            if (child.innerText && child.innerText.trim().startsWith('Production')) {
              hasChild = true;
              break;
            }
          }
          if (!hasChild) {
            targetOption = el;
            break;
          }
        }
      }
    }
    
    if (!targetOption) {
      // Fallback
      for (let el of all) {
        if (el.innerText && el.innerText.includes('Production')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.left > 500) {
            targetOption = el;
            break;
          }
        }
      }
    }
    
    if (!targetOption) {
      return { success: false, error: 'Production dropdown option not found' };
    }
    
    // Click the target option
    targetOption.scrollIntoView({ block: 'center' });
    targetOption.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseover', { bubbles: true }));
    targetOption.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mousedown', { bubbles: true }));
    targetOption.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseup', { bubbles: true }));
    targetOption.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true }));
    
    return {
      success: true,
      clickedTag: targetOption.tagName,
      clickedClass: targetOption.className,
      outerHTML: targetOption.outerHTML.slice(0, 300)
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- Smart Human-Like Form Automation Engine ---

async function fillFormInTab(fields, autoSubmit = false, submitLabel = 'submit') {
  function smartFindField(query, root = document) {
    if (!query) return null;
    const q = String(query).toLowerCase().trim();

    // 0. Direct CSS selector match (#id, .class, [name=...], input[type=...])
    try {
      const el = root.querySelector(query);
      if (el) return el;
    } catch (e) {}

    // 1. Direct ID or Name match
    try {
      let el = root.querySelector(`input#${CSS.escape(query)}, textarea#${CSS.escape(query)}, select#${CSS.escape(query)}`);
      if (!el) {
        el = root.querySelector(`[name="${CSS.escape(query)}"], [name="${CSS.escape(q)}"]`);
      }
      if (el) return el;
    } catch (e) {}

    // 2. <label> matching
    const labels = Array.from(root.querySelectorAll('label'));
    for (const lbl of labels) {
      const lblText = (lbl.innerText || lbl.textContent || '').toLowerCase().trim();
      if (lblText.includes(q) || q.includes(lblText)) {
        const forId = lbl.getAttribute('for');
        if (forId) {
          try {
            const target = root.getElementById ? root.getElementById(forId) : root.querySelector(`#${CSS.escape(forId)}`);
            if (target) return target;
          } catch (e) {}
        }
        const wrapped = lbl.querySelector('input, textarea, select, [contenteditable="true"]');
        if (wrapped) return wrapped;
      }
    }

    // 3. aria-label, placeholder, title, name, id, value on inputs
    const inputs = Array.from(root.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
    for (const item of inputs) {
      const aria = (item.getAttribute('aria-label') || '').toLowerCase().trim();
      const ph = (item.getAttribute('placeholder') || '').toLowerCase().trim();
      const title = (item.getAttribute('title') || '').toLowerCase().trim();
      const name = (item.getAttribute('name') || '').toLowerCase().trim();
      const id = (item.id || '').toLowerCase().trim();
      const val = (item.value || '').toLowerCase().trim();
      if (aria === q || ph === q || name === q || id === q || val === q) return item;
      if ((aria && aria.includes(q)) || (ph && ph.includes(q)) || (name && name.includes(q)) || (id && id.includes(q)) || (title && title.includes(q))) {
        return item;
      }
    }

    // 4. Preceding sibling, floating label or parent container header
    for (const item of inputs) {
      const parent = item.closest('div, section, p, li, td, .form-group, .field, [class*="field"], [class*="input"], [class*="form"]');
      if (parent) {
        const textNodes = Array.from(parent.querySelectorAll('label, span, p, div, strong, b'));
        for (const tNode of textNodes) {
          if (tNode !== item && !tNode.contains(item)) {
            const t = (tNode.innerText || tNode.textContent || '').toLowerCase().trim();
            if (t && (t === q || t.includes(q))) {
              return item;
            }
          }
        }
      }
    }

    // 5. Table rows: <tr><td>Label</td><td><input /></td></tr>
    const rows = Array.from(root.querySelectorAll('tr, [role="row"]'));
    for (const row of rows) {
      const rowText = (row.innerText || '').toLowerCase();
      if (rowText.includes(q)) {
        const rowInput = row.querySelector('input, textarea, select, [contenteditable="true"]');
        if (rowInput) return rowInput;
      }
    }

    // 6. Deep Shadow DOM traversal
    const allRoots = Array.from(root.querySelectorAll('*')).filter(e => e.shadowRoot);
    for (const host of allRoots) {
      const found = smartFindField(query, host.shadowRoot);
      if (found) return found;
    }

    return null;
  }

  function humanFillElement(el, value, options = {}) {
    try {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (e) {}

    // Visual highlight outline
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '2px solid #06b6d4';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      try {
        el.style.outline = prevOutline;
        el.style.outlineOffset = prevOffset;
      } catch (e) {}
    }, 800);

    // Focus
    el.focus();
    el.dispatchEvent(new (globalThis.FocusEvent || globalThis.Event)('focus', { bubbles: true }));

    const tagName = el.tagName.toLowerCase();
    const inputType = (el.type || '').toLowerCase();

    // 1. Checkbox
    if (inputType === 'checkbox') {
      const targetState = (value === true || value === 'true' || value === 1 || value === '1' || value === 'check' || value === 'on');
      if (el.checked !== targetState) {
        el.checked = targetState;
        el.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true }));
        el.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
      }
      return { success: true, type: 'checkbox', checked: el.checked };
    }

    // 2. Radio Button (with smart group auto-matching)
    if (inputType === 'radio') {
      if (typeof value === 'string' && el.name) {
        try {
          const group = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`));
          const targetRadio = group.find(r => {
            const rVal = (r.value || '').toLowerCase();
            const rParent = r.closest('label, p, div, li');
            const rText = rParent ? (rParent.innerText || '').toLowerCase() : '';
            return rVal === value.toLowerCase() || rText.includes(value.toLowerCase());
          });
          if (targetRadio) {
            targetRadio.checked = true;
            targetRadio.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true }));
            targetRadio.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
            return { success: true, type: 'radio', checked: true, value: targetRadio.value };
          }
        } catch (e) {}
      }
      el.checked = true;
      el.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', { bubbles: true }));
      el.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
      return { success: true, type: 'radio', checked: true };
    }

    // 3. Native <select> Dropdown
    if (tagName === 'select') {
      const valStr = String(value).toLowerCase().trim();
      let matchedOption = null;
      for (let i = 0; i < el.options.length; i++) {
        const opt = el.options[i];
        const optText = (opt.text || '').toLowerCase().trim();
        const optVal = (opt.value || '').toLowerCase().trim();
        if (optVal === valStr || optText === valStr || optText.includes(valStr) || valStr.includes(optText)) {
          matchedOption = opt;
          el.selectedIndex = i;
          break;
        }
      }
      if (matchedOption) {
        el.dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));
        el.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
        return { success: true, type: 'select', selected: matchedOption.text, value: matchedOption.value };
      }
      return { success: false, type: 'select', error: `Option matching "${value}" not found in dropdown` };
    }

    // 4. Rich Text / Contenteditable (Gmail, Notion, Slack, Google Docs, ProseMirror, Lexical)
    const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('role') === 'textbox';
    if (isContentEditable) {
      try {
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, String(value));
        if (!ok) {
          el.innerText = String(value);
        }
      } catch (e) {
        el.innerText = String(value);
      }
      el.dispatchEvent(new (globalThis.InputEvent || globalThis.Event)('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
      el.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true }));
      return { success: true, type: 'contenteditable', valueLength: String(value).length };
    }

    // 5. Standard inputs (text, email, password, number, tel, search, url, textarea)
    const valStr = String(value);
    const proto = tagName === 'textarea'
      ? (globalThis.HTMLTextAreaElement ? globalThis.HTMLTextAreaElement.prototype : null)
      : (globalThis.HTMLInputElement ? globalThis.HTMLInputElement.prototype : null);
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;

    if (el._valueTracker) {
      try { el._valueTracker.setValue(''); } catch (e) {}
    }

    if (descriptor && descriptor.set) {
      descriptor.set.call(el, '');
    } else {
      el.value = '';
    }
    el.dispatchEvent(new (globalThis.Event || Object)('input', { bubbles: true }));

    if (descriptor && descriptor.set) {
      descriptor.set.call(el, valStr);
    } else {
      el.value = valStr;
    }

    el.dispatchEvent(new (globalThis.InputEvent || globalThis.Event)('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: valStr }));
    el.dispatchEvent(new (globalThis.InputEvent || globalThis.Event)('input', { bubbles: true, cancelable: true, inputType: 'insertReplacementText', data: valStr }));
    el.dispatchEvent(new (globalThis.Event || Object)('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new (globalThis.FocusEvent || globalThis.Event)('blur', { bubbles: true }));

    return { success: true, type: tagName, inputType, valueLength: valStr.length };
  }

  function clickSubmit(targetText) {
    const q = String(targetText).toLowerCase().trim();
    const clickables = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], .btn, [class*="button"]'));
    let bestMatch = null;
    for (const item of clickables) {
      const text = (item.innerText || item.value || item.getAttribute('aria-label') || '').toLowerCase().trim();
      if (text === q || text.includes(q)) {
        bestMatch = item;
        break;
      }
    }
    if (bestMatch) {
      bestMatch.scrollIntoView({ block: 'center' });
      bestMatch.click();
      return true;
    }
    return false;
  }

  if (!fields || typeof fields !== 'object') {
    return { success: false, error: 'fields parameter must be an object of { fieldName: value }' };
  }

  const results = {};
  let totalSuccess = 0;
  let totalFields = 0;

  for (const [fieldName, val] of Object.entries(fields)) {
    totalFields++;
    const targetEl = smartFindField(fieldName);
    if (!targetEl) {
      results[fieldName] = { success: false, error: `Field "${fieldName}" not found on page` };
      continue;
    }

    try {
      const fillRes = humanFillElement(targetEl, val);
      results[fieldName] = fillRes;
      if (fillRes.success) totalSuccess++;
    } catch (err) {
      results[fieldName] = { success: false, error: err.message };
    }

    await new Promise(r => setTimeout(r, 60));
  }

  let submitted = false;
  if (autoSubmit && totalSuccess > 0) {
    await new Promise(r => setTimeout(r, 200));
    submitted = clickSubmit(submitLabel);
  }

  return {
    success: totalSuccess > 0,
    filledCount: totalSuccess,
    totalCount: totalFields,
    submitted,
    fields: results
  };
}

function smartClickInTab(targetText, role = null) {
  const q = String(targetText).toLowerCase().trim();
  const clickables = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"], [role="tab"], [role="menuitem"], .btn, [class*="button"]'));

  let bestMatch = null;
  for (const item of clickables) {
    const text = (item.innerText || item.value || item.getAttribute('aria-label') || '').toLowerCase().trim();
    if (text === q) {
      bestMatch = item;
      break;
    }
  }

  if (!bestMatch) {
    for (const item of clickables) {
      const text = (item.innerText || item.value || item.getAttribute('aria-label') || '').toLowerCase().trim();
      if (text.includes(q)) {
        bestMatch = item;
        break;
      }
    }
  }

  if (!bestMatch) {
    const all = Array.from(document.querySelectorAll('*'));
    for (const item of all) {
      if (item.children.length === 0) {
        const text = (item.innerText || item.textContent || '').toLowerCase().trim();
        if (text === q || (text && text.includes(q) && text.length < q.length + 20)) {
          bestMatch = item.closest('button, a, [role="button"]') || item;
          break;
        }
      }
    }
  }

  if (!bestMatch) {
    return { success: false, error: `Clickable element matching "${targetText}" not found` };
  }

  bestMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const prevStyle = bestMatch.getAttribute('style') || '';
  bestMatch.style.outline = '3px solid #7c3aed';
  bestMatch.style.outlineOffset = '2px';
  setTimeout(() => {
    try { bestMatch.setAttribute('style', prevStyle); } catch (e) {}
  }, 600);

  const mouseOpts = { bubbles: true, cancelable: true, view: window };
  bestMatch.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseover', mouseOpts));
  bestMatch.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseenter', mouseOpts));
  bestMatch.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mousedown', mouseOpts));
  try { bestMatch.focus(); } catch (e) {}
  bestMatch.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('mouseup', mouseOpts));
  bestMatch.dispatchEvent(new (globalThis.MouseEvent || globalThis.Event)('click', mouseOpts));

  return {
    success: true,
    tag: bestMatch.tagName.toLowerCase(),
    text: (bestMatch.innerText || bestMatch.value || '').trim().slice(0, 100)
  };
}

function pressKeyInTab(keyName, selector = null, modifiers = []) {
  let target = selector ? document.querySelector(selector) : document.activeElement;
  if (!target) target = document.body;

  const key = keyName;
  const isEnter = key.toLowerCase() === 'enter';
  const isTab = key.toLowerCase() === 'tab';
  const isEscape = key.toLowerCase() === 'escape';
  const code = isEnter ? 'Enter' : (isTab ? 'Tab' : (isEscape ? 'Escape' : key));
  const keyCode = isEnter ? 13 : (isTab ? 9 : (isEscape ? 27 : (key.charCodeAt(0) || 0)));

  const ctrlKey = modifiers.includes('ctrl') || modifiers.includes('control');
  const shiftKey = modifiers.includes('shift');
  const altKey = modifiers.includes('alt');
  const metaKey = modifiers.includes('meta') || modifiers.includes('cmd') || modifiers.includes('command');

  const eventOpts = {
    key,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    ctrlKey,
    shiftKey,
    altKey,
    metaKey,
    view: window
  };

  target.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keydown', eventOpts));
  target.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keypress', eventOpts));
  target.dispatchEvent(new (globalThis.KeyboardEvent || globalThis.Event)('keyup', eventOpts));

  if (isEnter && target.tagName === 'INPUT') {
    const form = target.closest('form');
    if (form) {
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        submitBtn.click();
      } else {
        form.dispatchEvent(new (globalThis.Event || Object)('submit', { bubbles: true, cancelable: true }));
      }
    }
  }

  return { success: true, key, target: target.tagName.toLowerCase() };
}


// Listen for message from popup/content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.action === 'ping') {
    // Content script ping wakes up SW and reconnects ONLY if currently disconnected.
    // NEVER disconnect an active, healthy WebSocket connection.
    if (shouldConnect()) {
      extLog('info', 'Ping received while disconnected. Triggering connect...');
      connect();
    }
    if (sendResponse) sendResponse({ success: true, connected: !shouldConnect() });
    return true;
  }
  if (message.action === 'reconnect') {
    extLog('info', 'Explicit reconnect requested from popup');
    reconnectDelay = 2000;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    connect();
    if (sendResponse) sendResponse({ success: true });
    return true;
  }
});

// Immediate top-level connection trigger when Service Worker script is evaluated
extLog('info', 'background.js top-level evaluation complete. Triggering connect()...');
connect();
