// BrowserAgentBridge - Extension Background Service Worker
const WS_URL = 'ws://localhost:1313/ws';
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let targetTabId = null;

function connect() {
  console.log('Connecting to BrowserAgentBridge Daemon...');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('Connected to Daemon!');
    reconnectDelay = 1000; // Reset reconnect delay
    chrome.storage.local.set({ connected: true });
    sendToDaemon({ type: 'status', status: 'connected' });
    startHeartbeat();
  };

  ws.onmessage = async (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('Received command:', message);
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
      console.error('Error parsing message:', err);
    }
  };

  ws.onclose = () => {
    console.log('Connection closed. Retrying in ' + reconnectDelay + 'ms...');
    chrome.storage.local.set({ connected: false });
    stopHeartbeat();
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
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
    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // Exponential backoff up to 30s
  }, reconnectDelay);
}

function sendToDaemon(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Start connection
connect();

// Command handler router
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
      return await captureScreenshot();
    case 'navigate':
      return await navigate(params.url, tabId);
    
    // Page-level actions that run scripts inside the tab
    case 'get_content':
      return await runInTab(getContentInTab, [], tabId);
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
  targetTabId = tab.id; // Store new tab
  return { id: tab.id, title: tab.title, url: tab.url };
}

async function selectTab(tabId) {
  const parsedId = parseInt(tabId);
  const tab = await chrome.tabs.update(parsedId, { active: true });
  targetTabId = parsedId; // Store selected tab
  // Also focus the window containing the tab
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
  try {
    const tab = await getTargetTab();
    if (!tab) throw new Error('No target tab found');
    
    // Capture active window visible area
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 75 });
    return dataUrl;
  } catch (err) {
    console.warn('Failed to capture screenshot:', err.message);
    // Return a transparent 1x1 PNG fallback so telemetry loop doesn't error out
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  }
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
    
    // Set a safety timeout
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
  if (tabs.length > 0 && isWebUrl(tabs[0].url)) return tabs[0];
  
  // 2. Try active tab in current window
  tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length > 0 && isWebUrl(tabs[0].url)) return tabs[0];
  
  // 3. Try active tab in any window
  tabs = await chrome.tabs.query({ active: true });
  const activeWebTabs = tabs.filter(t => isWebUrl(t.url));
  if (activeWebTabs.length > 0) return activeWebTabs[0];
  
  // 4. Try any web tab at all
  tabs = await chrome.tabs.query({});
  const webTabs = tabs.filter(t => isWebUrl(t.url));
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
      targetTabId = null; // Reset if tab closed/invalid
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
  
  // Cannot script on chrome://, edge://, about: or chrome-extension:// pages
  if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:') || tab.url.startsWith('chrome-extension://')) {
    throw new Error(`Cannot run browser automation on internal browser page: ${tab.url || 'empty'}`);
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: func,
    args: args
  });

  if (!results || results.length === 0) {
    throw new Error('Script execution returned no results');
  }

  return results[0].result;
}

// --- Injectable Content Functions ---
// Note: These run in the context of the target web page, so they cannot access extension APIs, only standard DOM.

function executeRawJs(code) {
  return eval(code);
}

function getContentInTab() {
  try {
    // Extract document title and location
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

    // 1. Traverse and build clean markdown
    function cleanText(str) {
      return str.replace(/\s+/g, ' ').trim();
    }

    function getElementSelector(el) {
      if (el.id) return `#${el.id}`;
      if (el.name) return `[name="${el.name}"]`;
      
      // Fallback: build a path
      let selector = el.tagName.toLowerCase();
      if (el.className) {
        const firstClass = el.className.split(' ')[0];
        if (firstClass && !firstClass.includes(':')) {
          selector += `.${firstClass}`;
        }
      }
      
      // Add text contents or placeholder identifiers if brief
      if (el.placeholder) {
        selector += `[placeholder="${el.placeholder}"]`;
      }
      
      return selector;
    }

    const interactiveElements = [];
    
    // Helper to extract clickable/form items
    const inputs = document.querySelectorAll('input, textarea, select, button, a');
    inputs.forEach((el, index) => {
      // Check if visible
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

      // Unique reference label
      const label = text ? `"${text}"` : (el.placeholder ? `placeholder "${el.placeholder}"` : `element ${index}`);

      interactiveElements.push({
        type,
        text,
        placeholder: el.placeholder || '',
        selector,
        label,
        rect: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      });
    });

    // Convert main body to semantic Markdown
    // Traverse DOM tree starting from body
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
    
    // Clean up markdown white space
    markdown = markdown.replace(/\n\s+\n/g, '\n\n').replace(/ +/g, ' ').trim();

    return {
      title,
      url,
      markdown,
      interactive_elements: interactiveElements.slice(0, 100) // limit to top 100 for token efficiency
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
    // Find element
    let el = null;
    
    // Helper to find element by CSS selector or XPath or Text Content
    if (selector.startsWith('//') || selector.startsWith('((')) {
      // XPath
      const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      el = result.singleNodeValue;
    } else {
      // Try CSS selector
      try {
        el = document.querySelector(selector);
      } catch (e) {
        // If invalid selector, fallback to searching by text content
      }
      
      if (!el) {
        // First try finding a table row tr or elements with role="row" containing the query text
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
        // Search by text content in typical clickables
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
        // Search inputs by placeholder
        const inputs = document.querySelectorAll('input, textarea');
        for (let item of inputs) {
          if (item.placeholder && item.placeholder.toLowerCase().includes(selector.toLowerCase())) {
            el = item;
            break;
          }
        }
      }

      if (!el) {
        // Fallback: Search the entire DOM for any visible leaf element containing the text query
        const allElements = document.querySelectorAll('*');
        for (let item of allElements) {
          if (item.innerText && item.innerText.includes(selector)) {
            const rect = item.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              // Check if it has child elements containing the same text (if not, it is the leaf node)
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

    // Highlight element
    const originalStyle = el.getAttribute('style') || '';
    el.style.outline = '3px solid #7c3aed';
    el.style.outlineOffset = '2px';
    el.style.transition = 'outline 0.3s ease';
    
    // Scroll into view
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });

    // Simulate click
    setTimeout(() => {
      // Restore style
      el.setAttribute('style', originalStyle);
    }, 1000);

    // Trigger events
    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true, cancelable: true });
    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    const mouseUpEvent = new MouseEvent('mouseup', { bubbles: true, cancelable: true });
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });

    el.dispatchEvent(mouseOverEvent);
    el.dispatchEvent(mouseDownEvent);
    el.focus();
    el.dispatchEvent(mouseUpEvent);
    el.dispatchEvent(clickEvent);

    // If it's a link with a href, we can also verify navigation
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
      // Try finding by placeholder
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

    // Highlight element
    const originalStyle = el.getAttribute('style') || '';
    el.style.outline = '3px solid #06b6d4';
    el.style.outlineOffset = '2px';
    
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus();

    // Clear value
    el.value = '';
    
    // Set value and trigger events character by character to satisfy input listeners
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

    // Trigger change event
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
    // Check if selector is a time delay (number)
    const delay = parseInt(selector);
    if (!isNaN(delay) && String(delay) === String(selector)) {
      setTimeout(() => {
        resolve({ success: true, waited: delay });
      }, delay);
      return;
    }

    // Otherwise wait for selector
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
    
    // Dispatch input/change events to notify React/Angular/Gmail JS
    q.dispatchEvent(new Event('input', { bubbles: true }));
    q.dispatchEvent(new Event('change', { bubbles: true }));
    
    // Dispatch Enter key events to trigger the search trigger handlers
    const keyOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    q.dispatchEvent(new KeyboardEvent('keydown', keyOpts));
    q.dispatchEvent(new KeyboardEvent('keypress', keyOpts));
    q.dispatchEvent(new KeyboardEvent('keyup', keyOpts));
    
    // Also try clicking the search button as a backup
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
