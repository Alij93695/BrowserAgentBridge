// BrowserAgentBridge - Extension Background Service Worker
const WS_URL = 'ws://127.0.0.1:1313/ws';
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 5000; // Start with 5s delay
const MAX_RECONNECT_DELAY = 300000; // Cap at 5 minutes to avoid flooding console
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
      resolver(result);
    }
    pendingScreenshotResolvers = [];
    return result;
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

// --- WebSocket Connection (with smart backoff & silent reconnect) ---

function connect() {
  // Clean up any existing connection
  if (ws) {
    try { ws.close(); } catch (e) { /* ignore */ }
    ws = null;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch (err) {
    // WebSocket constructor failed (very rare). Schedule silent retry.
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('BrowserAgentBridge: Connected to Daemon');
    reconnectDelay = 5000; // Reset backoff on successful connect
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
        console.error('Error executing command:', err);
        sendToDaemon({ id, success: false, error: err.message });
      }
    } catch (err) {
      console.error('Error parsing daemon message:', err);
    }
  };

  ws.onclose = () => {
    chrome.storage.local.set({ connected: false });
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // Suppress noisy "WebSocket error: [object Event]" — the onclose handler
    // already manages reconnection. Only log at debug level.
    chrome.storage.local.set({ connected: false });
    stopHeartbeat();
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
    // Exponential backoff: 1s → 2s → 4s → 8s → ... → 60s max
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Start connection
connect();

// Schedule a periodic connection check alarm (runs even if service worker is suspended)
chrome.alarms.get('checkConnection', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('checkConnection', { periodInMinutes: 1 });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkConnection') {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.log('BrowserAgentBridge: Connection check alarm fired. Attempting to connect...');
      connect();
    }
  }
});

// Wake up and connect on navigation events (to ensure fast connection when active)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) { // Only main frame navigations
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connect();
    }
  }
});

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
    case 'click':
      return await runInTab(clickElementInTab, [params.selector], tabId);
    case 'type':
      return await runInTab(typeTextInTab, [params.selector, params.text], tabId);
    case 'scroll':
      return await runInTab(scrollInTab, [params.direction, params.amount], tabId);
    case 'wait':
      return await runInTab(waitInTab, [params.selector, params.timeout], tabId);
    case 'execute':
      return await runInTab(executeRawJs, [params.code], tabId);
    case 'gmail_search':
      return await runInTab(gmailSearchInTab, [params.query], tabId);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// --- Browser-Level Commands ---

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    favIconUrl: t.favIconUrl
  }));
}

async function newTab(url = 'https://www.google.com', active = true) {
  const tab = await chrome.tabs.create({ url, active });
  targetTabId = tab.id;
  return { id: tab.id, title: tab.title, url: tab.url };
}

async function selectTab(tabId) {
  const parsedId = parseInt(tabId);
  const tab = await chrome.tabs.update(parsedId, { active: true });
  targetTabId = parsedId;
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return { id: tab.id, title: tab.title, url: tab.url };
}

async function closeTab(tabId) {
  const parsedId = parseInt(tabId);
  await chrome.tabs.remove(parsedId);
  if (targetTabId === parsedId) {
    targetTabId = null;
  }
  return { success: true };
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
    // Block Chrome Web Store, Edge Add-ons, and local browser pages
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

async function runInTab(func, args = [], tabId = null) {
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
      const timeout = setTimeout(resolve, 8000); // Safety timeout
      function onUpdated(tId, changeInfo) {
        if (tId === tab.id && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
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
      args: args
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
  return eval(code);
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
      if (node.nodeType === Node.TEXT_NODE) {
        const text = cleanText(node.textContent);
        if (text) markdown += text + ' ';
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

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
      const all = document.querySelectorAll('*');
      all.forEach(el => {
        if (el.childNodes.length > 0 && Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.includes('Identity info'))) {
          identityElements.push({
            tagName: el.tagName,
            className: el.className,
            outerHTML: el.outerHTML.slice(0, 150)
          });
        }
      });
    } catch(e) {}

    return {
      title,
      url,
      markdown,
      interactive_elements: interactiveElements.slice(0, 100),
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
      const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
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

    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const mouseUpEvent = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });

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
    try {
      el = document.querySelector(selector);
    } catch (e) {}

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

      const keydown = new KeyboardEvent('keydown', { key: char, charCode: char.charCodeAt(0), bubbles: true });
      const keypress = new KeyboardEvent('keypress', { key: char, charCode: char.charCodeAt(0), bubbles: true });

      el.dispatchEvent(keydown);
      el.dispatchEvent(keypress);

      el.value = currentVal;

      const inputEvent = new Event('input', { bubbles: true });
      el.dispatchEvent(inputEvent);

      const keyup = new KeyboardEvent('keyup', { key: char, charCode: char.charCodeAt(0), bubbles: true });
      el.dispatchEvent(keyup);
    }

    const changeEvent = new Event('change', { bubbles: true });
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
      const el = document.querySelector(selector);
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

    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));

    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    q.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    q.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    q.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

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

// Listen for message from popup to force reconnect
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'reconnect') {
    console.log('BrowserAgentBridge: Reconnect triggered from popup.');
    reconnectDelay = 5000;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    connect();
    sendResponse({ success: true });
  }
});
