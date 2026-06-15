// Text-to-Speech Background Service Worker
// Handles installation, default settings, and the speak-selection command.
//
// Normal pages: the live selection is read directly with chrome.scripting.
// PDFs (Chrome's built-in viewer): the selection lives inside the viewer's
// plugin, not the DOM, so we inject a script into the PDF's frame and ask the
// viewer for its selection through its internal postMessage interface. No
// debugger is used, so Chrome shows no "debugging this browser" banner.

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
// Offscreen document (clipboard fallback for restricted pages)
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
    justification: 'Read the clipboard for text-to-speech on restricted pages'
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
// PDF selection via the viewer's postMessage interface (no debugger)
// ---------------------------------------------------------------------------

function isPdfUrl(url) {
  if (!url) return false;
  const base = url.toLowerCase().split('#')[0].split('?')[0];
  return base.endsWith('.pdf');
}

// Injected into the page (MAIN world). For the frame that hosts Chrome's PDF
// plugin, asks the viewer for the current selection and waits for its reply.
// Returns a small diagnostics object so failures are debuggable.
function pdfSelectionProbe() {
  return new Promise((resolve) => {
    const out = {
      href: location.href,
      ct: document.contentType,
      direct: '',
      embedFound: false,
      embedType: '',
      gotReply: false,
      text: ''
    };

    try { out.direct = ((window.getSelection && window.getSelection().toString()) || '').trim(); } catch (e) {}
    if (out.direct) { out.text = out.direct; resolve(out); return; }

    const embed = document.querySelector(
      'embed[type="application/pdf"], embed[type="application/x-google-chrome-pdf"], embed[name="plugin"], embed'
    );
    if (!embed) { resolve(out); return; }
    out.embedFound = true;
    out.embedType = embed.getAttribute('type') || '';

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('message', handler);
      resolve(out);
    };

    const handler = (event) => {
      const d = event.data;
      if (d && (d.type === 'getSelectedTextReply' || d.type === 'getSelectionReply')) {
        out.gotReply = true;
        out.text = ((d.selectedText != null ? d.selectedText : d.selection) || '').trim();
        finish();
      }
    };
    window.addEventListener('message', handler);

    // The PDF MimeHandlerView <embed> exposes a postMessage method; also try
    // its contentWindow as a fallback for other frame arrangements.
    try { if (typeof embed.postMessage === 'function') embed.postMessage({ type: 'getSelectedText' }, '*'); } catch (e) {}
    try { if (embed.contentWindow) embed.contentWindow.postMessage({ type: 'getSelectedText' }, '*'); } catch (e) {}

    setTimeout(finish, 800);
  });
}

async function getPdfSelection(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: pdfSelectionProbe
    });
  } catch (e) {
    console.error('TTS: PDF probe injection failed:', e.message,
      '\nFor local file:// PDFs, enable "Allow access to file URLs" for this extension at chrome://extensions.');
    return '';
  }

  for (const r of results) {
    const v = r.result || {};
    console.log('TTS: PDF frame —', {
      href: v.href, contentType: v.ct, embedFound: v.embedFound,
      embedType: v.embedType, gotReply: v.gotReply, textLen: (v.text || '').length
    });
  }
  for (const r of results) {
    if (r.result && r.result.text) return r.result.text.trim();
  }
  return '';
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
      // Injection blocked — likely the PDF viewer; handled below.
    }

    // 2. PDF: ask the viewer for its selection via postMessage (no debugger).
    if (!selectedText && looksLikePdf) {
      selectedText = await getPdfSelection(tab.id);
    }

    // 3. Restricted non-PDF pages: fall back to whatever the user has copied.
    if (!selectedText && !looksLikePdf) {
      try { selectedText = await readClipboard(); } catch (_) {}
    }

    if (!selectedText) {
      console.log('TTS: no text to read (selection empty / viewer did not reply)');
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
