// Clipboard reader popup - reads clipboard and sends result back
async function readAndSend() {
  let text = '';
  let error = null;

  try {
    // Ensure window has focus
    window.focus();

    // Small delay to ensure focus is established
    await new Promise(r => setTimeout(r, 50));

    text = await navigator.clipboard.readText();
    console.log('Clipboard read success:', text.substring(0, 50));
  } catch (err) {
    console.error('Clipboard read error:', err);
    error = err.message;
  }

  // Send result back to background script
  chrome.runtime.sendMessage({
    type: 'clipboardResult',
    text: text.trim(),
    error: error
  });

  // Close this window
  window.close();
}

// Run when document is ready and focused
if (document.hasFocus()) {
  readAndSend();
} else {
  window.addEventListener('focus', readAndSend, { once: true });
  window.focus();
}
