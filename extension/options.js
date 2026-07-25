import { API_BASE } from "./config.js";

const url = API_BASE.replace(/\/$/, "") + "/";
document.getElementById("dashUrl").textContent = url;
document.getElementById("openDash").addEventListener("click", () => {
  chrome.tabs.create({ url });
});
