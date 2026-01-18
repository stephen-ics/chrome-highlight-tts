// Text-to-Speech Popup Settings Script

const elements = {
  enableToggle: document.getElementById('enableToggle'),
  triggerKey: document.getElementById('triggerKey'),
  recordKey: document.getElementById('recordKey'),
  voiceSelect: document.getElementById('voiceSelect'),
  speedSlider: document.getElementById('speedSlider'),
  speedValue: document.getElementById('speedValue'),
  pitchSlider: document.getElementById('pitchSlider'),
  pitchValue: document.getElementById('pitchValue'),
  testButton: document.getElementById('testButton'),
  saveButton: document.getElementById('saveButton'),
  status: document.getElementById('status')
};

let currentSettings = {
  enabled: true,
  speed: 1,
  pitch: 1,
  voiceName: '',
  triggerKey: 'Space'
};

let isRecordingKey = false;

// Load available voices
function loadVoices() {
  const voices = speechSynthesis.getVoices();
  elements.voiceSelect.innerHTML = '<option value="">Default</option>';

  voices.forEach(voice => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    elements.voiceSelect.appendChild(option);
  });

  // Set current voice if saved
  if (currentSettings.voiceName) {
    elements.voiceSelect.value = currentSettings.voiceName;
  }
}

// Format key code for display
function formatKeyCode(code) {
  // Make key codes more readable
  return code
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Arrow', '')
    .replace('Numpad', 'Num ');
}

// Load saved settings
function loadSettings() {
  chrome.storage.sync.get(['ttsSettings'], (result) => {
    if (result.ttsSettings) {
      currentSettings = { ...currentSettings, ...result.ttsSettings };

      elements.enableToggle.checked = currentSettings.enabled;
      elements.triggerKey.value = formatKeyCode(currentSettings.triggerKey);
      elements.speedSlider.value = currentSettings.speed;
      elements.pitchSlider.value = currentSettings.pitch;
      elements.speedValue.textContent = `${currentSettings.speed.toFixed(1)}x`;
      elements.pitchValue.textContent = currentSettings.pitch.toFixed(1);

      // Voice will be set when voices are loaded
      if (speechSynthesis.getVoices().length > 0) {
        elements.voiceSelect.value = currentSettings.voiceName || '';
      }
    }
  });
}

// Save settings
function saveSettings() {
  const settings = {
    enabled: elements.enableToggle.checked,
    triggerKey: currentSettings.triggerKey,
    speed: parseFloat(elements.speedSlider.value),
    pitch: parseFloat(elements.pitchSlider.value),
    voiceName: elements.voiceSelect.value
  };

  chrome.storage.sync.set({ ttsSettings: settings }, () => {
    currentSettings = settings;
    showStatus('Settings saved!', 'success');
  });
}

// Test voice
function testVoice() {
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance('Hello! This is a test of the text-to-speech settings.');
  utterance.rate = parseFloat(elements.speedSlider.value);
  utterance.pitch = parseFloat(elements.pitchSlider.value);

  const voiceName = elements.voiceSelect.value;
  if (voiceName) {
    const voice = speechSynthesis.getVoices().find(v => v.name === voiceName);
    if (voice) {
      utterance.voice = voice;
    }
  }

  speechSynthesis.speak(utterance);
}

// Show status message
function showStatus(message, type) {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`;

  setTimeout(() => {
    elements.status.className = 'status';
  }, 2000);
}

// Event listeners
elements.speedSlider.addEventListener('input', () => {
  elements.speedValue.textContent = `${parseFloat(elements.speedSlider.value).toFixed(1)}x`;
});

elements.pitchSlider.addEventListener('input', () => {
  elements.pitchValue.textContent = parseFloat(elements.pitchSlider.value).toFixed(1);
});

elements.testButton.addEventListener('click', testVoice);
elements.saveButton.addEventListener('click', saveSettings);

// Key recording
elements.recordKey.addEventListener('click', () => {
  isRecordingKey = true;
  elements.triggerKey.classList.add('recording');
  elements.triggerKey.value = 'Press a key...';
  elements.triggerKey.focus();
});

document.addEventListener('keydown', (e) => {
  if (!isRecordingKey) return;

  e.preventDefault();
  e.stopPropagation();

  // Store the actual key code
  currentSettings.triggerKey = e.code;
  elements.triggerKey.value = formatKeyCode(e.code);
  elements.triggerKey.classList.remove('recording');
  isRecordingKey = false;
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();

  // Voices may not be immediately available
  if (speechSynthesis.getVoices().length > 0) {
    loadVoices();
  }

  speechSynthesis.onvoiceschanged = loadVoices;

  // Set correct shortcut key based on platform
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const shortcutKey = document.getElementById('shortcutKey');
  if (shortcutKey) {
    shortcutKey.textContent = isMac ? '⌘+Shift+P' : 'Ctrl+Shift+P';
  }

  // Handle shortcut customization link
  const shortcutLink = document.getElementById('shortcutLink');
  if (shortcutLink) {
    shortcutLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });
  }
});
