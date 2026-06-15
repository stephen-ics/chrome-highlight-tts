// Offscreen document: read and write the clipboard for TTS.
// navigator.clipboard can fail in an unfocused offscreen document, so each
// operation falls back to the execCommand path that works without focus.

async function readClipboardText() {
  try {
    const text = await navigator.clipboard.readText();
    return { text: (text || '').trim(), error: null };
  } catch (err) {
    try {
      const textarea = document.createElement('textarea');
      document.body.appendChild(textarea);
      textarea.focus();
      const ok = document.execCommand('paste');
      const text = textarea.value;
      document.body.removeChild(textarea);
      return { text: (text || '').trim(), error: ok ? null : 'Paste failed' };
    } catch (err2) {
      return { text: '', error: err2.message };
    }
  }
}

async function writeClipboardText(text) {
  const value = text || '';
  try {
    await navigator.clipboard.writeText(value);
    return { success: true, error: null };
  } catch (err) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return { success: ok, error: ok ? null : 'Copy failed' };
    } catch (err2) {
      return { success: false, error: err2.message };
    }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.source !== 'background') return false;

  if (message.type === 'readClipboard') {
    readClipboardText().then((result) => {
      chrome.runtime.sendMessage({ type: 'clipboardResult', text: result.text, error: result.error });
    });
    return false;
  }

  if (message.type === 'writeClipboard') {
    writeClipboardText(message.text).then((result) => {
      chrome.runtime.sendMessage({ type: 'clipboardWriteResult', success: result.success, error: result.error });
    });
    return false;
  }

  return false;
});
