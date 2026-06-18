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

// Initial check
chrome.storage.local.get(['connected'], (result) => {
  updateUI(result.connected || false);
});

// Listen for changes
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.connected) {
    updateUI(changes.connected.newValue);
  }
});
