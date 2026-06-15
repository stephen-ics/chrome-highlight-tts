// Text-to-Speech Background Service Worker
// Handles installation, default settings, and the speak-selection command.
//
// On normal pages the live selection is read directly with chrome.scripting.
// On PDFs, Chrome renders the document inside a sandboxed viewer frame that
// content scripts cannot reach, so we copy the current selection via the
// chrome.debugger API (synthesizing Cmd/Ctrl+C) and read it back from the
// clipboard through an offscreen document. The user's clipboard is restored
// afterwards so this stays invisible.

const DEFAULT_SETTINGS = {
  enabled: true,
  speed: 1,
  pitch: 1,
  voiceName: '',
  triggerKey: 'Space'
};

const IS_MAC = navigator.userAgent.includes('Macintosh') || navigator.userAgent.includes('Mac OS');

// Initialize default settings on install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set({ ttsSettings: DEFAULT_SETTINGS });
  }
});

// ---------------------------------------------------------------------------
// Offscreen document (clipboard read/write)
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
    justification: 'Read and restore the clipboard for text-to-speech'
  });
  // Give the document a moment to register its message listener.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Send a request to the offscreen document and wait for its typed reply.
async function clipboardRequest(type, payload, replyType, timeoutMs) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(type + ' timeout'));
    }, timeoutMs);

    const listener = (message) => {
      if (message && message.type === replyType) {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        if (message.error) reject(new Error(message.error));
        else resolve(message);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({ type, source: 'background', ...payload });
  });
}

async function readClipboard(timeoutMs = 1500) {
  const res = await clipboardRequest('readClipboard', {}, 'clipboardResult', timeoutMs);
  return res.text || '';
}

async function writeClipboard(text, timeoutMs = 1500) {
  try {
    const res = await clipboardRequest('writeClipboard', { text }, 'clipboardWriteResult', timeoutMs);
    return !!res.success;
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PDF selection via the debugger API
// ---------------------------------------------------------------------------

function isPdfUrl(url) {
  if (!url) return false;
  const base = url.toLowerCase().split('#')[0].split('?')[0];
  return base.endsWith('.pdf');
}

function canAttachDebugger(url) {
  if (!url) return false;
  const blocked = ['chrome://', 'chrome-extension://', 'edge://', 'devtools://', 'about:', 'view-source:'];
  if (blocked.some((p) => url.startsWith(p))) return false;
  if (url.startsWith('https://chrome.google.com/webstore') ||
      url.startsWith('https://chromewebstore.google.com')) return false;
  return true;
}

function debuggerSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

function attachDebugger(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function detachDebugger(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError; // ignore detach errors
      resolve();
    });
  });
}

// Synthesize the platform copy shortcut (Cmd+C on mac, Ctrl+C elsewhere).
async function dispatchCopyShortcut(target) {
  const mod = IS_MAC ? 4 /* Meta */ : 2 /* Ctrl */;
  const modKey = IS_MAC
    ? { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 91 }
    : { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  const cKey = { key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67 };

  await debuggerSend(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mod, ...modKey });
  await debuggerSend(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: mod, ...cKey });
  await debuggerSend(target, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mod, ...cKey });
  await debuggerSend(target, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, ...modKey });
}

// Copy the current PDF selection to the clipboard, read it, then restore the
// user's previous clipboard contents. Returns the selected text (or '').
async function copyPdfSelectionViaDebugger(tabId) {
  const target = { tabId };
  const sentinel = '__TTS_SENTINEL__' + Date.now() + '__';

  let original = '';
  try { original = await readClipboard(); } catch (_) { original = ''; }

  let attached = false;
  try {
    await attachDebugger(target);
    attached = true;
    console.log('TTS: debugger attached to tab', tabId);

    // Mark the clipboard so we can tell whether the copy actually landed,
    // even if the selection happens to equal the previous clipboard text.
    const sentinelWritten = await writeClipboard(sentinel);
    const baseline = sentinelWritten ? sentinel : original;

    await dispatchCopyShortcut(target);

    // The copy completes asynchronously; poll until the clipboard changes.
    let copied = '';
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      let clip = '';
      try { clip = await readClipboard(); } catch (_) { clip = ''; }
      if (clip && clip !== baseline) { copied = clip; break; }
    }

    console.log('TTS: PDF copy result —',
      copied ? `${copied.length} chars: "${copied.slice(0, 50)}..."` : '(nothing copied)');
    return copied.trim();
  } finally {
    if (attached) await detachDebugger(target);
    // Best-effort restore of the user's original clipboard.
    await writeClipboard(original).catch(() => {});
  }
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
    let looksLikePdf = isPdfUrl(tab.url);
    let execThrew = false;

    // 1. Regular pages: read the live selection from every frame we can reach.
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => ({
          sel: ((window.getSelection && window.getSelection().toString()) || '').trim(),
          ct: document.contentType
        })
      });
      for (const r of results) {
        if (r.result?.sel) { selectedText = r.result.sel; break; }
        if (r.result?.ct === 'application/pdf') looksLikePdf = true;
      }
    } catch (_) {
      // Injection blocked (the PDF viewer, or a file:// page without file
      // access) — treat that as a strong hint to try the debugger path below.
      execThrew = true;
    }

    // 2. PDF: copy the selection through the debugger, then read it back.
    const tryDebugger = !selectedText && canAttachDebugger(tab.url) &&
      (looksLikePdf || (execThrew && (tab.url || '').startsWith('file://')));
    if (tryDebugger) {
      try {
        selectedText = await copyPdfSelectionViaDebugger(tab.id);
      } catch (e) {
        console.error('TTS: PDF copy failed:', e);
      }
    }

    // 3. Restricted non-PDF pages: fall back to whatever the user has copied.
    if (!selectedText && !looksLikePdf) {
      try { selectedText = await readClipboard(); } catch (_) {}
    }

    if (!selectedText) {
      console.log('TTS: no text to read (selection empty / copy failed)');
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
  // Clipboard traffic is handled by the offscreen document / clipboardRequest.
  if (message.type === 'readClipboard' || message.type === 'clipboardResult' ||
      message.type === 'writeClipboard' || message.type === 'clipboardWriteResult') {
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
