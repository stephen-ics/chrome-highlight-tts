// Offscreen document for clipboard access
console.log('TTS Offscreen: Document loaded and ready');

async function readClipboardText() {
  // Try Clipboard API first (modern approach)
  try {
    const text = await navigator.clipboard.readText();
    console.log('TTS Offscreen: Clipboard API success:', text ? `"${text.substring(0, 50)}..."` : '(empty)');
    return { text: text.trim(), error: null };
  } catch (err) {
    console.log('TTS Offscreen: Clipboard API failed:', err.message);
  }

  // Fallback to execCommand
  try {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    const success = document.execCommand('paste');
    const text = textarea.value;
    document.body.removeChild(textarea);
    console.log('TTS Offscreen: execCommand paste:', success, text ? `"${text.substring(0, 50)}..."` : '(empty)');
    return { text: text.trim(), error: success ? null : 'Paste failed' };
  } catch (err) {
    console.log('TTS Offscreen: execCommand failed:', err.message);
    return { text: '', error: err.message };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('TTS Offscreen: Received message:', message.type);

  if (message.type === 'readClipboard' && message.source === 'background') {
    console.log('TTS Offscreen: Reading clipboard now...');

    readClipboardText().then(result => {
      console.log('TTS Offscreen: Sending result back');
      chrome.runtime.sendMessage({
        type: 'clipboardResult',
        text: result.text,
        error: result.error
      });
    });

    return false;
  }
});
