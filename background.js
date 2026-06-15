// Text-to-Speech Background Service Worker
// Handles installation, default settings, and the speak-selection command.
//
// Normal pages: the live selection is read directly with chrome.scripting.
// PDFs / restricted pages: Chrome's viewer keeps its selection inside a
// sandboxed process we can't read, so the flow is "copy, then narrate" — the
// user presses Cmd+C (their own trusted keystroke puts the text on the system
// clipboard), then the shortcut reads the clipboard and speaks it. No debugger,
// so no "debugging this browser" banner.

const DEFAULT_SETTINGS = {
  enabled: true,
  speed: 1,
  pitch: 1,
  voiceName: '',
  triggerKey: 'Space'
};

// Initialize default settings on install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({ ttsSettings: DEFAULT_SETTINGS });
  }
});

// ---------------------------------------------------------------------------
// Offscreen document (clipboard read — service workers can't read it directly)
// ---------------------------------------------------------------------------

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen.html')]
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['CLIPBOARD'],
    justification: 'Read the clipboard to read copied text aloud'
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function readClipboard(timeoutMs = 1500) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error('clipboard read timeout'));
    }, timeoutMs);

    const listener = (message) => {
      if (message && message.type === 'clipboardResult') {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.error) reject(new Error(message.error));
        else resolve(message.text || '');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type: 'readClipboard', source: 'background' });
  });
}

// ---------------------------------------------------------------------------
// Speak-selection command
// ---------------------------------------------------------------------------

function ttsIsSpeaking() {
  return new Promise((resolve) => chrome.tts.isSpeaking((speaking) => resolve(!!speaking)));
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'speak-selection') return;

  // Toggle: stop if we're already reading.
  if (await ttsIsSpeaking()) {
    chrome.tts.stop();
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    console.log('TTS: command on', tab.url);

    const { ttsSettings } = await chrome.storage.sync.get(['ttsSettings']);
    const settings = { ...DEFAULT_SETTINGS, ...(ttsSettings || {}) };
    if (!settings.enabled) return;

    let selectedText = '';

    // 1. Normal pages: read the live selection from every frame we can reach.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => ((window.getSelection && window.getSelection().toString()) || '').trim()
      });
      for (const r of results) {
        if (r.result) { selectedText = r.result; break; }
      }
    } catch (_) {
      // Injection blocked (PDF viewer / restricted page) — use the clipboard.
    }

    // 2. PDF / restricted pages: narrate what the user copied with Cmd+C.
    if (!selectedText) {
      try {
        selectedText = await readClipboard();
        console.log('TTS: read clipboard —', selectedText ? `${selectedText.length} chars` : '(empty)');
      } catch (e) {
        console.error('TTS: clipboard read failed:', e.message);
      }
    }

    if (!selectedText) {
      console.log('TTS: nothing to read — select text and press Cmd+C first on PDFs');
      return;
    }
    console.log(`TTS: speaking ${selectedText.length} chars`);

    const ttsOptions = {
      rate: settings.speed || 1,
      pitch: settings.pitch || 1,
      onEvent: (event) => {
        if (event.type === 'error') console.error('TTS: speak error:', event.errorMessage);
      }
    };

    // Only request a specific voice if chrome.tts actually offers it — a stale
    // name (e.g. a Web Speech / remote voice) would make speak() fail silently.
    if (settings.voiceName) {
      const voices = await new Promise((resolve) => chrome.tts.getVoices(resolve));
      if (voices.some((v) => v.voiceName === settings.voiceName)) {
        ttsOptions.voiceName = settings.voiceName;
      } else {
        console.warn(`TTS: voice "${settings.voiceName}" unavailable; using default`);
      }
    }

    chrome.tts.speak(selectedText, ttsOptions);
  } catch (error) {
    console.error('TTS: Command error:', error);
  }
});

// ---------------------------------------------------------------------------
// Settings messaging (popup)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
