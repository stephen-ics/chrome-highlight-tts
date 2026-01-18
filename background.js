// Text-to-Speech Background Service Worker
// Handles extension installation, default settings, and keyboard commands

const DEFAULT_SETTINGS = {
  enabled: true,
  speed: 1,
  pitch: 1,
  voiceName: '',
  triggerKey: 'Space'
};

let isSpeaking = false;

// Ensure offscreen document exists for clipboard access
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });

  if (existingContexts.length > 0) {
    console.log('TTS: Offscreen document already exists');
    return;
  }

  console.log('TTS: Creating offscreen document...');
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Read clipboard for TTS'
  });
  console.log('TTS: Offscreen document created');

  // Give it a moment to initialize
  await new Promise(resolve => setTimeout(resolve, 100));
}

// Initialize default settings on install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({ ttsSettings: DEFAULT_SETTINGS });
  }
});

// Handle keyboard command (Ctrl+Shift+S) - works on PDFs and all pages
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'speak-selection') return;

  console.log('TTS: Command triggered');

  // If speaking, stop
  if (isSpeaking) {
    chrome.tts.stop();
    isSpeaking = false;
    console.log('TTS: Stopped speaking');
    return;
  }

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      console.log('TTS: No active tab');
      return;
    }

    console.log('TTS: Active tab URL:', tab.url);
    let selectedText = '';

    // Check if this is a restricted URL (chrome://, chrome-extension://)
    const isRestrictedUrl = tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://');
    const isPdfUrl = tab.url?.toLowerCase().includes('.pdf') || tab.url?.toLowerCase().includes('/pdf');

    if (!isRestrictedUrl) {
      // Try executeScript first (works on regular pages)
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () => window.getSelection().toString().trim()
        });

        // Check all frames for selected text
        for (const result of results) {
          if (result.result) {
            selectedText = result.result;
            break;
          }
        }
        console.log('TTS: executeScript result:', selectedText ? `"${selectedText.substring(0, 50)}..."` : '(empty)');
      } catch (scriptError) {
        console.log('TTS: executeScript failed:', scriptError.message);
      }

      // If no text and might be a PDF, try PDF postMessage API
      if (!selectedText && isPdfUrl) {
        console.log('TTS: PDF detected, trying postMessage API...');
        try {
          selectedText = await getPdfSelection(tab.id);
          console.log('TTS: PDF postMessage result:', selectedText ? `"${selectedText.substring(0, 50)}..."` : '(empty)');
        } catch (pdfError) {
          console.error('TTS: PDF postMessage failed:', pdfError);
        }
      }
    } else {
      console.log('TTS: Restricted URL detected, using clipboard only');
    }

    // If no text yet, try clipboard (required for chrome-extension:// URLs, or as fallback)
    if (!selectedText) {
      console.log('TTS: Trying clipboard...');
      try {
        selectedText = await readClipboard();
        console.log('TTS: Clipboard result:', selectedText ? `"${selectedText.substring(0, 50)}..."` : '(empty)');
      } catch (clipError) {
        console.error('TTS: Clipboard fallback failed:', clipError);
      }
    }

    if (!selectedText) {
      console.log('TTS: No text found');
      return;
    }

    // Get current settings
    const { ttsSettings } = await chrome.storage.sync.get(['ttsSettings']);
    const settings = ttsSettings || DEFAULT_SETTINGS;

    if (!settings.enabled) {
      console.log('TTS: Extension disabled');
      return;
    }

    // Build TTS options
    const ttsOptions = {
      rate: settings.speed || 1,
      pitch: settings.pitch || 1,
      onEvent: (event) => {
        if (event.type === 'start') {
          isSpeaking = true;
        } else if (event.type === 'end' || event.type === 'error' || event.type === 'cancelled') {
          isSpeaking = false;
        }
      }
    };

    // Add voice if specified
    if (settings.voiceName) {
      ttsOptions.voiceName = settings.voiceName;
    }

    // Speak the text
    console.log('TTS: Speaking text...');
    chrome.tts.speak(selectedText, ttsOptions);

  } catch (error) {
    console.error('TTS: Command error:', error);
    isSpeaking = false;
  }
});

// Get PDF selection using Chrome's undocumented postMessage API
async function getPdfSelection(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('PDF selection timeout'));
    }, 2000);

    // Inject script to query PDF embed and relay response
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        return new Promise((resolve) => {
          const embed = document.querySelector('embed[type="application/pdf"]');
          if (!embed) {
            resolve('');
            return;
          }

          const messageId = 'tts_' + Date.now();

          const handler = (event) => {
            if (event.data && event.data.type === 'getSelectedTextReply') {
              window.removeEventListener('message', handler);
              resolve(event.data.selectedText || '');
            }
          };

          window.addEventListener('message', handler);

          // Send request to PDF viewer
          embed.postMessage({ type: 'getSelectedText' }, '*');

          // Timeout fallback
          setTimeout(() => {
            window.removeEventListener('message', handler);
            resolve('');
          }, 1500);
        });
      }
    }).then(results => {
      clearTimeout(timeout);
      const text = results?.[0]?.result || '';
      resolve(text.trim());
    }).catch(err => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// Read clipboard using offscreen document (reliable in MV3)
async function readClipboard() {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log('TTS: Clipboard read timed out');
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('Clipboard read timeout'));
    }, 3000);

    const listener = (message) => {
      if (message.type === 'clipboardResult') {
        console.log('TTS: Received clipboardResult:', message);
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.error) {
          reject(new Error(message.error));
        } else {
          resolve(message.text || '');
        }
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    console.log('TTS: Sending readClipboard message to offscreen...');
    chrome.runtime.sendMessage({
      type: 'readClipboard',
      source: 'background'
    });
  });
}

// Handle messages from popup or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore clipboard messages (handled by offscreen.js)
  if (message.type === 'readClipboard' || message.type === 'clipboardResult') {
    return false;
  }

  if (message.type === 'getSettings') {
    chrome.storage.sync.get(['ttsSettings'], (result) => {
      sendResponse(result.ttsSettings || DEFAULT_SETTINGS);
    });
    return true;
  }

  if (message.type === 'saveSettings') {
    chrome.storage.sync.set({ ttsSettings: message.settings }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});
