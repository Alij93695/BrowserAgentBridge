// Lightweight content script trigger to wake up background service worker automatically
(function() {
  try {
    chrome.runtime.sendMessage({ action: 'ping' }, (res) => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  } catch (e) {
    // Ignore context invalidated errors
  }
})();
