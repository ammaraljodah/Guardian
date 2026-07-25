// Keyboard activity: report key presses to the background worker. Uses keydown
// (not keyup) so rich-text editor iframes (TinyMCE, etc.) are captured reliably.
(function () {
  if (globalThis.__guardianKeys) return;
  globalThis.__guardianKeys = true;

  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

  function isPasswordField(target) {
    if (!target || !target.closest) return false;
    const field = target.closest("input, textarea");
    return field && field.type === "password";
  }

  function onKeyDown(e) {
    if (e.repeat || e.isComposing || isPasswordField(e.target)) return;
    if (MODIFIERS.has(e.key)) return;
    const now = Date.now();
    try {
      chrome.runtime.sendMessage(
        { type: "KEY_PRESS", key: e.key, downTs: now, upTs: now },
        () => void chrome.runtime.lastError
      );
    } catch (err) {
      /* extension context gone */
    }
  }

  function bind() {
    window.addEventListener("keydown", onKeyDown, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind, { once: true });
  } else {
    bind();
  }
})();
