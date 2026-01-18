// Text-to-Speech Content Script
// Listens for space key and reads selected text aloud

let settings = {
  enabled: true,
  speed: 1,
  pitch: 1,
  voiceName: '',
  triggerKey: 'Space'
};

let isSpeaking = false;

// Load settings from storage
chrome.storage.sync.get(['ttsSettings'], (result) => {
  if (result.ttsSettings) {
    settings = { ...settings, ...result.ttsSettings };
  }
});

// Listen for settings updates
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.ttsSettings) {
    settings = { ...settings, ...changes.ttsSettings.newValue };
  }
});

function isInputElement(element) {
  if (!element) return false;

  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
    return true;
  }

  if (element.isContentEditable || element.contentEditable === 'true') {
    return true;
  }

  // Check for common editor roles
  const role = element.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox') {
    return true;
  }

  return false;
}

function speakSelectedText() {
  const selection = window.getSelection().toString().trim();
  if (!selection) return false;

  // Stop any current speech
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(selection);
  utterance.rate = settings.speed || 1;
  utterance.pitch = settings.pitch || 1;

  // Find the selected voice
  const voices = speechSynthesis.getVoices();
  if (settings.voiceName && voices.length > 0) {
    const voice = voices.find(v => v.name === settings.voiceName);
    if (voice) {
      utterance.voice = voice;
    }
  }

  utterance.onstart = () => {
    isSpeaking = true;
  };

  utterance.onend = () => {
    isSpeaking = false;
  };

  utterance.onerror = () => {
    isSpeaking = false;
  };

  speechSynthesis.speak(utterance);
  return true;
}

function stopSpeaking() {
  speechSynthesis.cancel();
  isSpeaking = false;
}

document.addEventListener('keydown', (e) => {
  // Only respond to configured trigger key
  if (e.code !== settings.triggerKey) return;

  // Check if extension is enabled
  if (!settings.enabled) return;

  // Don't interfere with input elements (except for non-typing keys like F-keys)
  const isTypingKey = !e.code.startsWith('F') || e.code.length > 3;
  if (isTypingKey && isInputElement(document.activeElement)) return;

  // Check if text is selected
  const selection = window.getSelection().toString().trim();
  if (!selection) return;

  // Prevent default scroll behavior
  e.preventDefault();

  // Toggle behavior: stop if speaking, speak if not
  if (isSpeaking) {
    stopSpeaking();
  } else {
    speakSelectedText();
  }
});

// Preload voices (they may not be available immediately)
speechSynthesis.getVoices();
speechSynthesis.onvoiceschanged = () => {
  speechSynthesis.getVoices();
};
