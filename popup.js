const DISPLAY_COUNT_KEY = "recentReposDisplayCount";
const DISPLAY_MIN = 1;
const DISPLAY_MAX = 50;
const DISPLAY_DEFAULT = 10;

function clampCount(value) {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return DISPLAY_DEFAULT;
  return Math.min(DISPLAY_MAX, Math.max(DISPLAY_MIN, Math.round(n)));
}

function init() {
  const input = document.getElementById("display-count");
  const saveBtn = document.getElementById("save");
  const status = document.getElementById("status");

  chrome.storage.local.get([DISPLAY_COUNT_KEY], (result) => {
    input.value = String(clampCount(result[DISPLAY_COUNT_KEY]));
  });

  saveBtn.addEventListener("click", () => {
    const next = clampCount(input.value);
    input.value = String(next);
    chrome.storage.local.set({ [DISPLAY_COUNT_KEY]: next }, () => {
      status.textContent = "Saved.";
      status.classList.add("is-success");
      window.setTimeout(() => {
        status.textContent = "";
        status.classList.remove("is-success");
      }, 1600);
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
