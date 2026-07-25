// Content-based category detection. The fixed domain lists can't cover every
// site, so we also inspect the page's own content: if the text/meta of a page
// strongly matches an enabled blocked category, we ask the background worker to
// block the tab. Detection config (keywords + thresholds) comes from the
// background so it always reflects the parent's currently-enabled categories.
(function () {
  function gatherText() {
    let parts = [document.title || ""];
    const metas = document.querySelectorAll(
      'meta[name="keywords"], meta[name="description"], meta[name="rating"], meta[property="og:title"], meta[property="og:description"], meta[property="og:type"]'
    );
    metas.forEach((m) => parts.push(m.getAttribute("content") || ""));
    if (document.body && document.body.innerText) {
      parts.push(document.body.innerText.slice(0, 20000));
    }
    return parts.join(" \n ").toLowerCase();
  }

  // The RTA label is a widely-used self-labelling tag for adult sites.
  function hasAdultRatingTag() {
    const el = document.querySelector('meta[name="rating"]');
    const val = (el?.getAttribute("content") || "").toLowerCase();
    return val.includes("rta-5042") || val === "adult" || val === "mature";
  }

  function detect(config) {
    const text = gatherText();
    if (!text) return;

    let best = null;
    for (const [category, cfg] of Object.entries(config)) {
      let score = 0;
      for (const kw of cfg.keywords || []) {
        if (text.includes(kw)) score++;
      }
      if (category === "adult" && hasAdultRatingTag()) score += cfg.threshold;

      if (score >= (cfg.threshold || 2)) {
        if (!best || score > best.score) best = { category, score };
      }
    }

    if (best) {
      chrome.runtime.sendMessage({
        type: "CATEGORY_DETECTED",
        category: best.category
      });
    }
  }

  function start() {
    chrome.runtime.sendMessage({ type: "GET_DETECTION_CONFIG" }, (config) => {
      if (chrome.runtime.lastError || !config || !config.categories) return;
      if (Object.keys(config.categories).length === 0) return;
      try {
        detect(config.categories);
      } catch (e) {
        /* ignore */
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
