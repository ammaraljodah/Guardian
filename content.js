// Lightweight heuristic detector for web-based proxy / "unblocker" pages that
// aren't in the domain list. If several tell-tale phrases appear together,
// we ask the background worker to block the tab (only acts if the parent has
// the "Proxies / Anonymizers" category enabled).
(function () {
  const KEYWORDS = [
    "free web proxy",
    "unblock websites",
    "unblock any website",
    "anonymous browsing",
    "cors anywhere",
    "web proxy server",
    "bypass filter",
    "bypass school",
    "hide your ip",
    "surf anonymously",
    "enter url to unblock"
  ];

  function scan() {
    try {
      const text = (document.body?.innerText || "").toLowerCase();
      if (!text) return;
      let hits = 0;
      for (const k of KEYWORDS) {
        if (text.includes(k)) hits++;
      }
      const title = (document.title || "").toLowerCase();
      if (/\b(web )?proxy\b|unblock/.test(title)) hits++;

      if (hits >= 2) {
        chrome.runtime.sendMessage({ type: "PROXY_DETECTED" });
      }
    } catch (e) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan, { once: true });
  } else {
    scan();
  }
})();
