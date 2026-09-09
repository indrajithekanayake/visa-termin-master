const FIELDS = ["intervalMinutes", "twoCaptchaKey", "ntfyTopic", "sweepPauseSeconds",
                "autoFailLimit"];
const FLAGS = ["autoReload"];

chrome.storage.local.get("settings").then(({ settings = {} }) => {
  FIELDS.forEach((k) => { if (settings[k] !== undefined) document.getElementById(k).value = settings[k]; });
  FLAGS.forEach((k) => { document.getElementById(k).checked = !!settings[k]; });
});

async function save() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  FIELDS.forEach((k) => { settings[k] = document.getElementById(k).value.trim(); });
  FLAGS.forEach((k) => { settings[k] = document.getElementById(k).checked; });
  const int = (k, dflt, lo, hi) => {
    const v = parseInt(settings[k], 10);
    settings[k] = Number.isNaN(v) ? dflt : Math.min(hi, Math.max(lo, v));
  };
  int("intervalMinutes", 2, 2, 360);
  int("sweepPauseSeconds", 5, 0, 60);
  int("autoFailLimit", 4, 1, 10);
  // Floored at 1: a zero-minute wait would be a reload loop, not a cool-down.
  await chrome.storage.local.set({ settings });
}

document.getElementById("save").addEventListener("click", async () => {
  await save();
  const s = document.getElementById("saved");
  s.classList.add("on");
  setTimeout(() => s.classList.remove("on"), 1400);
});

document.getElementById("clearSession").addEventListener("click", async () => {
  const out = document.getElementById("sessionResult");
  out.className = "";
  out.textContent = "Clearing…";
  const res = await chrome.runtime.sendMessage({ type: "clearSession" });
  const ok = res && res.ok;
  out.className = ok ? "good" : "bad";
  out.textContent = ok
    ? `Cleared the last ${res.hours} hours of cookies — reload the portal tab.`
    : "Could not clear cookies.";
});

document.getElementById("testPush").addEventListener("click", async () => {
  const out = document.getElementById("pushResult");
  out.className = "";
  out.textContent = "Sending...";
  await save();
  const res = await chrome.runtime.sendMessage({ type: "testPush" });
  const ok = res && res.ok;
  out.className = ok ? "good" : "bad";
  out.textContent = ok ? "Sent - check your phone."
                       : (res && res.error) || "Failed to send.";
});
