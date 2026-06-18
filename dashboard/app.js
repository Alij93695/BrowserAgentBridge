// Antigravity WebBridge - Dashboard Client Application
document.addEventListener('DOMContentLoaded', () => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/dashboard_ws`;
  let socket = null;

  // DOM Elements
  const connectionBadge = document.getElementById('connection-badge');
  const connectionText = document.getElementById('connection-text');
  const tabCountBadge = document.getElementById('tab-count-badge');
  const tabsList = document.getElementById('tabs-list');
  const consoleLogs = document.getElementById('console-logs');
  const activeTabAddress = document.getElementById('active-tab-address');
  const liveScreenPlaceholder = document.getElementById('live-screen-placeholder');
  const liveScreenshot = document.getElementById('live-screenshot');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const btnRefreshView = document.getElementById('btn-refresh-view');
  
  // Form / Playground Elements
  const urlForm = document.getElementById('url-form');
  const urlInput = document.getElementById('url-input');
  const selectAction = document.getElementById('select-action');
  const playgroundParamContainer = document.getElementById('playground-param-container');
  const playgroundParamLabel = document.getElementById('playground-param-label');
  const inputParam = document.getElementById('input-param');
  const playgroundTextContainer = document.getElementById('playground-text-container');
  const inputText = document.getElementById('input-text');
  const btnRunCmd = document.getElementById('btn-run-cmd');
  const playgroundResult = document.getElementById('playground-result');

  // Connect Telemetry WebSocket
  function connectTelemetry() {
    appendLog('system', 'Connecting to telemetry daemon...');
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      appendLog('system', 'Connected to telemetry stream.');
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleTelemetryMessage(data);
      } catch (err) {
        console.error('Error parsing WS message:', err);
      }
    };

    socket.onclose = () => {
      updateConnectionStatus(false);
      appendLog('error', 'Telemetry connection closed. Reconnecting in 3s...');
      setTimeout(connectTelemetry, 3000);
    };

    socket.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  // Handle Telemetry Updates
  function handleTelemetryMessage(data) {
    switch (data.type) {
      case 'connection':
        updateConnectionStatus(data.connected);
        break;
      case 'logs_history':
        clearLogs();
        data.logs.forEach(log => appendLogRaw(log.timestamp, log.message));
        break;
      case 'log':
        appendLogRaw(data.log.timestamp, data.log.message);
        break;
      case 'tabs':
        renderTabsList(data.tabs);
        break;
      case 'screenshot':
        updateScreenshot(data.screenshot);
        break;
    }
  }

  // Update connection indicator
  function updateConnectionStatus(connected) {
    if (connected) {
      connectionBadge.className = 'badge badge-connected';
      connectionText.textContent = 'Connected';
    } else {
      connectionBadge.className = 'badge badge-disconnected';
      connectionText.textContent = 'Disconnected';
      
      // Reset some UI elements on disconnect
      tabCountBadge.textContent = '0 tabs';
      tabsList.innerHTML = '<div class="empty-state">No open tabs found. Connect browser extension.</div>';
      activeTabAddress.textContent = 'about:blank';
      liveScreenshot.classList.add('hidden');
      liveScreenPlaceholder.classList.remove('hidden');
    }
  }

  // Render Open Tabs
  function renderTabsList(tabs) {
    tabCountBadge.textContent = `${tabs.length} tabs`;
    if (tabs.length === 0) {
      tabsList.innerHTML = '<div class="empty-state">No open tabs.</div>';
      activeTabAddress.textContent = 'about:blank';
      return;
    }

    tabsList.innerHTML = '';
    tabs.forEach(tab => {
      const item = document.createElement('div');
      item.className = `tab-item ${tab.active ? 'active' : ''}`;
      
      if (tab.active) {
        activeTabAddress.textContent = tab.url;
        urlInput.value = tab.url; // Prep the navigation input too
      }

      // Default icon helper
      const iconUrl = tab.favIconUrl || 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';

      item.innerHTML = `
        <img class="tab-icon" src="${iconUrl}" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot; width=&quot;16&quot; height=&quot;16&quot; viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;%2394a3b8&quot; stroke-width=&quot;2&quot;><circle cx=&quot;12&quot; cy=&quot;12&quot; r=&quot;10&quot;/><line x1=&quot;2&quot; y1=&quot;12&quot; x2=&quot;22&quot; y2=&quot;12&quot;/></svg>'">
        <div class="tab-info">
          <div class="tab-title" title="${tab.title || 'Untitled'}">${tab.title || 'Untitled'}</div>
          <div class="tab-url" title="${tab.url}">${tab.url}</div>
        </div>
        <button class="tab-close-btn" data-id="${tab.id}" title="Close Tab">&times;</button>
      `;

      // Click to select tab
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('tab-close-btn')) {
          e.stopPropagation();
          const tabId = e.target.getAttribute('data-id');
          sendAPICommand('close_tab', { tab_id: tabId });
        } else {
          sendAPICommand('select_tab', { tab_id: tab.id });
        }
      });

      tabsList.appendChild(item);
    });
  }

  // Update Screenshot
  function updateScreenshot(base64Data) {
    if (!base64Data) return;
    liveScreenPlaceholder.classList.add('hidden');
    liveScreenshot.src = base64Data;
    liveScreenshot.classList.remove('hidden');
  }

  // Logging helpers
  function appendLog(type, message) {
    const time = new Date().toTimeString().split(' ')[0];
    appendLogRaw(time, `[${type.toUpperCase()}] ${message}`);
  }

  function appendLogRaw(timestamp, message) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    
    let styleClass = 'system';
    if (message.includes('Sent command') || message.includes('Received API')) styleClass = 'command';
    else if (message.includes('connected') || message.includes('success')) styleClass = 'success';
    else if (message.includes('Error') || message.includes('failed') || message.includes('disconnected')) styleClass = 'error';
    
    entry.classList.add(styleClass);
    entry.innerHTML = `<span class="log-time">${timestamp}</span>${escapeHTML(message)}`;
    consoleLogs.appendChild(entry);
    
    // Auto-scroll logs
    consoleLogs.parentElement.scrollTop = consoleLogs.parentElement.scrollHeight;
  }

  function clearLogs() {
    consoleLogs.innerHTML = '';
  }

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  // REST API Command Sender
  async function sendAPICommand(action, params = {}) {
    appendLog('command', `Executing: ${action} with ${JSON.stringify(params)}`);
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params })
      });
      
      const data = await response.json();
      if (data.success) {
        appendLog('success', `Action ${action} succeeded.`);
        return data.result;
      } else {
        appendLog('error', `Action ${action} failed: ${data.error}`);
        throw new Error(data.error);
      }
    } catch (err) {
      appendLog('error', `API Request failed: ${err.message}`);
      throw err;
    }
  }

  // Navigate Bar Submit
  urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = urlInput.value.trim();
    if (!url) return;
    
    try {
      await sendAPICommand('navigate', { url });
    } catch (err) {
      // Logged in sendAPICommand
    }
  });

  // Reload viewport screenshot
  btnRefreshView.addEventListener('click', async () => {
    try {
      const result = await sendAPICommand('screenshot');
      updateScreenshot(result);
    } catch (err) {
      // Logged
    }
  });

  // Clear Logs
  btnClearLogs.addEventListener('click', () => {
    clearLogs();
  });

  // Playground Parameter Inputs Sync
  selectAction.addEventListener('change', () => {
    const action = selectAction.value;
    
    // Reset defaults
    playgroundParamContainer.classList.remove('hidden');
    playgroundTextContainer.classList.add('hidden');
    inputParam.value = '';
    inputText.value = '';

    switch (action) {
      case 'get_content':
        playgroundParamContainer.classList.add('hidden');
        break;
      case 'screenshot':
        playgroundParamContainer.classList.add('hidden');
        break;
      case 'click':
        playgroundParamLabel.textContent = 'CSS Selector / XPath / Text';
        inputParam.placeholder = 'e.g. button#submit or "Log In"';
        break;
      case 'type':
        playgroundParamLabel.textContent = 'Target Input Selector';
        inputParam.placeholder = 'e.g. input[name="username"] or "Email"';
        playgroundTextContainer.classList.remove('hidden');
        break;
      case 'scroll':
        playgroundParamLabel.textContent = 'Direction (down/up/bottom/top)';
        inputParam.placeholder = 'down';
        break;
      case 'wait':
        playgroundParamLabel.textContent = 'Selector or Delay (ms)';
        inputParam.placeholder = 'e.g. #loading-spinner or 2000';
        break;
    }
  });

  // Playground Run
  btnRunCmd.addEventListener('click', async () => {
    const action = selectAction.value;
    const params = {};

    switch (action) {
      case 'click':
        if (!inputParam.value.trim()) {
          playgroundResult.textContent = 'Error: Selector parameter is required.';
          return;
        }
        params.selector = inputParam.value.trim();
        break;
      case 'type':
        if (!inputParam.value.trim()) {
          playgroundResult.textContent = 'Error: Target selector is required.';
          return;
        }
        params.selector = inputParam.value.trim();
        params.text = inputText.value;
        break;
      case 'scroll':
        params.direction = inputParam.value.trim() || 'down';
        params.amount = 400; // default scrolling size
        break;
      case 'wait':
        if (!inputParam.value.trim()) {
          playgroundResult.textContent = 'Error: Wait target is required.';
          return;
        }
        params.selector = inputParam.value.trim();
        params.timeout = 5000;
        break;
    }

    playgroundResult.textContent = 'Executing command...';
    btnRunCmd.disabled = true;

    try {
      const result = await sendAPICommand(action, params);
      playgroundResult.textContent = JSON.stringify(result, null, 2);
    } catch (err) {
      playgroundResult.textContent = `Error: ${err.message}`;
    } finally {
      btnRunCmd.disabled = false;
    }
  });

  // Initialize
  connectTelemetry();
});
