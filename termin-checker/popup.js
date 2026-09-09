const HOST = "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do";

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/* Elapsed time as d/h/m, so a run measured in days stays readable. */
function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const row = (label, value, cls) =>
  `<div class="stat ${cls || ""}"><span class="k">${label}</span><span class="v">${value}</span></div>`;

function pct(good, bad) {
  const n = good + bad;
  return n ? Math.round((good / n) * 100) + "%" : "—";
}

async function render() {
  const { lastResult, settings = {}, stats = {}, lastPushError = "", captchaShape } =
    await chrome.storage.local.get(["lastResult", "settings", "stats", "lastPushError", "captchaShape"]);

  const el = document.getElementById("state");
  if (lastResult) {
    const { state, dates = [], at } = lastResult;
    if (state === "dates" && dates.length) {
      el.className = "state good";
      el.innerHTML = `<div class="big">${dates.length} date${dates.length > 1 ? "s" : ""} available</div>
        <ul>${dates.map((d) => `<li>${d.text}</li>`).join("")}</ul>
        <div class="when">${ago(at)}</div>`;
    } else {
      el.className = "state";
      const label = state === "blocked" ? "Rate-limited"
        : state === "booking" ? "Booking — watching paused"
        : state === "day" ? "Choosing a time — watching paused"
        : state === "captcha" ? "Waiting on captcha"
        : state === "unknown" ? "Page not recognised — re-checking"
        : "No appointments";
      el.innerHTML = `<div class="big">${label}</div><div class="when">${ago(at)}</div>`;
    }
  }

  const auto = { ok: stats.autoSolved || 0, bad: stats.autoFailed || 0 };
  const polls = stats.autoPolls || 0;

  // Runtime is measured from the first unattended poll, not from the reset:
  // counters can sit untouched for days before watching actually starts.
  const runFrom = stats.firstPollAt || 0;
  const runTo = stats.lastPollAt || Date.now();
  const running = runFrom ? elapsed(runTo - runFrom) : "not started";
  const rate = runFrom && polls > 1
    ? ` · ${(polls / Math.max(1, (runTo - runFrom) / 60000)).toFixed(1)}/min`
    : "";

  document.getElementById("stats").innerHTML =
    row("Running for", `<span id="runval">${running}</span>`) +
    row("Auto-refreshes", polls) +
    row("Solved by 2Captcha", auto.ok, "hit") +
    row("2Captcha got it wrong", auto.bad, auto.bad ? "miss" : "") +
    row("Typed by hand", stats.manualSolved || 0) +
    row("Appointments found", stats.appointmentsFound || 0, "hit") +
    row("Times rate-limited", stats.blocked || 0, stats.blocked ? "miss" : "") +
    // The two that tell you the portal has soured the session, which is the
    // failure that costs money quietly rather than announcing itself.
    row("2Captcha errors", stats.apiErrors || 0, stats.apiErrors ? "miss" : "") +
    row("Cookie clears (24h)", stats.sessionResets || 0) +
    // What the solver is being told about these captchas. Shown because a hint
    // learned from a bad sample is otherwise invisible, and it is the first
    // thing to suspect if accuracy drops after it kicks in.
    row("Captcha shape learned", captchaShape && captchaShape.samples
      ? (captchaShape.min === captchaShape.max ? captchaShape.min : captchaShape.min + "–" + captchaShape.max)
        + (captchaShape.digits ? " digits" : " chars")
        + (captchaShape.samples < 8 ? ` (${captchaShape.samples}/8)` : "")
      : "—") +
    // How often it hit the end of the ladder and waited rather than stopping.
    // A climbing number here is the sign to look at the key or the interval.
    `<div class="rate">2Captcha accuracy ${pct(auto.ok, auto.bad)}` +
      `${auto.ok + auto.bad ? ` over ${auto.ok + auto.bad} attempts` : ""}${rate}` +
      `${stats.since ? ` · since ${ago(stats.since)}` : ""}</div>` +
    (settings.twoCaptchaKey ? "" :
      `<div class="rate warn">No 2Captcha key set — captchas must be typed by hand.
       Add one in Settings for hands-off running.</div>`) +
    // A phone alert that has silently stopped working is worse than none at all,
    // since the whole point is being able to walk away and trust it.
    (settings.ntfyTopic && lastPushError ?
      `<div class="rate warn">Last phone alert failed: ${lastPushError}.
       Re-test it in Settings.</div>` : "");

  // Whichever appointment page was last open identifies itself, so this button
  // follows you rather than needing three values copied out of a URL.
  document.getElementById("open").onclick = async () => {
    const { portal } = await chrome.storage.local.get("portal");
    const p = (portal && portal.realmId) ? portal
            : { locationCode: "colo", realmId: "1419", categoryId: "3728" };
    chrome.tabs.create({ url: `${HOST}?${new URLSearchParams(p)}` });
  };
}

document.getElementById("opts").onclick = () => chrome.runtime.openOptionsPage();
document.getElementById("reset").onclick = async () => {
  await chrome.runtime.sendMessage({ type: "resetStats" });
  render();
};

render();

/* Tick only the runtime cell. Re-rendering the whole panel once a second would
 * rebuild the buttons and their handlers just to move a clock. */
setInterval(async () => {
  const cell = document.getElementById("runval");
  if (!cell) return;
  const { stats = {} } = await chrome.storage.local.get("stats");
  if (!stats.firstPollAt) return;
  cell.textContent = elapsed((stats.lastPollAt || Date.now()) - stats.firstPollAt);
}, 1000);

// Refresh the whole panel only when something actually changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.stats || changes.lastResult || changes.settings)) render();
});
