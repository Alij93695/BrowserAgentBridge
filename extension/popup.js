// popup.js - Updates status in popup window

function updateUI(connected) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  
  if (connected) {
    dot.classList.add('connected');
    text.textContent = 'Connected';
    text.style.color = '#10b981';
  } else {
    dot.classList.remove('connected');
    text.textContent = 'Disconnected';
    text.style.color = '#ef4444';
  }
}

function triggerReconnect() {
  chrome.runtime.sendMessage({ action: 'reconnect' }, (response) => {
    if (chrome.runtime.lastError) { /* ignore */ }
  });
  try {
    fetch('http://127.0.0.1:1313/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level: 'info', message: 'Popup Reconnect button clicked' })
    }).catch(() => {});
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-reconnect');
  if (btn) {
    btn.addEventListener('click', () => {
      triggerReconnect();
    });
  }
});

// Initial check & request reconnect from background service worker
chrome.storage.local.get(['connected'], (result) => {
  updateUI(result.connected || false);
  triggerReconnect();
});

// Listen for changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.connected) {
    updateUI(changes.connected.newValue);
  }
});
