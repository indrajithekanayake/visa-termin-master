/*
 * Service worker: notifications, badge, and the optional 2Captcha relay.
 *
 * The month page itself is never fetched from here. The portal keeps its
 * session in a ;jsessionid path parameter on the form action, and the captcha
 * is bound to that session, so reading the image in one context and posting
 * from another lands in a different session and can never validate. All page
 * work therefore happens in the content script, inside the real page.
 */

const DEFAULTS = {
  intervalMinutes: 2,       // fixed, around the clock - slots do appear overnight
  autoReload: true,
  twoCaptchaKey: "",
  ntfyTopic: "",            // empty turns phone alerts off
  sweepPauseSeconds: 5,     // visible beat between the two months; 0 = instant
  /*
   * Consecutive failures before the cookie wipe. Four, as asked for.
   *
   * Wrong answers and solver errors both count. They used to be separated, on
   * the argument that clearing cookies cannot fix an empty balance - true, but
   * it also means there is only one rule to reason about, and a bad key shows
   * up plainly in the panel and in the popup's 2Captcha-errors count.
   */
  autoFailLimit: 4
};

const STATS = {
  autoPolls: 0,
  autoSolved: 0, autoFailed: 0,           // solved by 2Captcha
  manualSolved: 0, manualFailed: 0,       // typed by hand
  appointmentsFound: 0, blocked: 0, sessionResets: 0, apiErrors: 0,
  since: 0,        // when the counters were last reset
  firstPollAt: 0,  // when unattended polling first ran after that reset
  lastPollAt: 0
};

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

function badge(text, color) {
  chrome.action.setBadgeText({ text: text || "" });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

/* The category page, with no jsessionid: this URL is handed to the phone and
 * to the notification click, and a session id from this machine would be dead
 * or misleading on either.
 *
 * Named for the category rather than the month because content.js has its own
 * monthUrl(offset), which means something else entirely - it steps relative to
 * the month on screen. Two different functions under one name is a trap for
 * whoever greps for it next. */
const DEFAULT_PORTAL = { locationCode: "colo", realmId: "1419", categoryId: "3728" };

async function portalContext() {
  const { portal } = await chrome.storage.local.get("portal");
  return portal && portal.realmId ? portal : DEFAULT_PORTAL;
}

function categoryUrl(p) {
  return "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do"
    + `?locationCode=${encodeURIComponent(p.locationCode)}`
    + `&realmId=${encodeURIComponent(p.realmId)}`
    + `&categoryId=${encodeURIComponent(p.categoryId)}`;
}

/*
 * Phone alerts via ntfy.sh.
 *
 * The desktop notification only helps when you are at the desk, and the whole
 * point of unattended polling is that you are not. Off unless a topic is set.
 *
 * Published as JSON to the root endpoint rather than as headers on /<topic>:
 * ntfy reads header values as latin-1, and the portal's German month names
 * ("Marz" with an umlaut) come out mangled that way. The JSON body is UTF-8.
 */
const NTFY_URL = "https://ntfy.sh/";
const PUSH_REPEAT_MINUTES = 1;   // fixed: one a minute while the slot is open
const PUSH_REPEAT_CAP = 12;      // then stop, so it cannot buzz all day

/* Accepts a bare topic or a whole ntfy URL pasted out of the app. */
function ntfyTopic(raw) {
  const last = String(raw || "").trim().replace(/\/+$/, "").split("/").pop();
  return /^[-_A-Za-z0-9]{1,64}$/.test(last) ? last : "";
}

async function pushToPhone(dates, opts = {}) {
  const s = await getSettings();
  const topic = ntfyTopic(s.ntfyTopic);
  if (!topic) return false;

  const list = dates.map((d) => d.text).join(", ");
  const n = dates.length;

  try {
    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        title: opts.test
          ? "RK-Termin test alert"
          : `${n} appointment date${n > 1 ? "s" : ""} available`,
        message: opts.test
          ? "If this reached your phone, the alarm is wired up correctly."
          : (opts.repeat ? "Still open - " : "") +
            (list.length > 400 ? list.slice(0, 400) + "..." : list),
        priority: 5,   // max: the long, insistent alert tone rather than a blip
        tags: opts.test ? ["white_check_mark"] : ["rotating_light", "calendar"],
        click: categoryUrl(await portalContext())
      })
    });
    if (!res.ok) throw new Error(`ntfy returned ${res.status} ${res.statusText}`);
    await chrome.storage.local.set({ lastPushError: "" });
    return true;
  } catch (err) {
    // A dead phone alert must never take the desktop notification down with it,
    // so this swallows the failure and records it for the options page instead.
    await chrome.storage.local.set({
      lastPushError: String(err && err.message ? err.message : err)
    });
    if (opts.test) throw err;
    return false;
  }
}

/*
 * A slot that stays open still needs you at the keyboard, and a single push at
 * 04:00 is easy to sleep through. While the same set of dates remains available
 * the alert repeats on a timer, capped so an unattended run cannot spend the
 * whole day buzzing at you.
 */
async function repeatPush(dates) {
  const s = await getSettings();
  if (!ntfyTopic(s.ntfyTopic) || !dates.length) return;

  const sig = dates.map((d) => d.text).sort().join("|");
  const { pushState = {} } = await chrome.storage.local.get("pushState");
  if (pushState.sig !== sig) return;                       // a changed set arrives as "found"
  if ((pushState.count || 0) >= PUSH_REPEAT_CAP) return;
  if (Date.now() - (pushState.lastAt || 0) < PUSH_REPEAT_MINUTES * 60000) return;

  await chrome.storage.local.set({
    pushState: { sig, lastAt: Date.now(), count: (pushState.count || 0) + 1 }
  });
  await pushToPhone(dates, { repeat: true });
}

async function notifyFound(dates) {
  const list = dates.map((d) => d.text).join(", ");
  await chrome.notifications.create("rktermin-" + Date.now(), {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `${dates.length} appointment date${dates.length > 1 ? "s" : ""} available`,
    message: list.length > 180 ? list.slice(0, 180) + "…" : list,
    priority: 2,
    requireInteraction: true
  });
  badge(String(dates.length), "#137333");
}

/* -------------------------------------------------------- portal session */

/*
 * Drop the portal's session cookies.
 *
 * Sustained polling from one session eventually gets that session served
 * captchas that cannot be solved - uniformly black or white images that no
 * amount of paying will get past. It is a soft block: the site keeps answering,
 * nothing ever validates, and the solver bill keeps running. Clearing the
 * cookies is what recovers it, because the reputation is attached to the
 * session rather than to you.
 *
 * Scoped by URL rather than by a broad domain sweep, so this only ever touches
 * cookies that service2.diplo.de itself would see.
 */
/*
 * Recovery: drop the last 24 hours of cookies.
 *
 * Everything else was tried first and none of it worked on this portal. The
 * cookies API reports nothing for service2.diplo.de even with host access
 * granted, the tab visible to the worker and the page itself holding a
 * JSESSIONID, so targeted removal by name, path, domain or store all removed
 * exactly nothing. This does not target: it drops the window and lets the
 * portal issue a fresh session on the next load.
 *
 * Scoped by TIME, not by site: every site is in range, but only cookies whose
 * CREATION date falls inside the window. That is a narrower blast radius than
 * it first sounds. Re-issuing a cookie with the same name, domain and path
 * preserves its original creation date (RFC 6265 5.3.11.3), so a login from
 * last week that is refreshed on every request still reads as last week and
 * survives. What goes is what was first set in the window - today's new logins,
 * today's session cookies, and the portal's own.
 */
const CLEAR_WINDOW_HOURS = 24;

async function clearRecentCookies() {
  try {
    await chrome.browsingData.removeCookies({
      since: Date.now() - CLEAR_WINDOW_HOURS * 3600 * 1000
    });
    return true;
  } catch (_) {
    return false;
  }
}


/* ------------------------------------------------------------ poll alarm */

/*
 * What schedules a poll.
 *
 * The wait used to be counted down by a setInterval inside the page, which
 * Chrome throttles to one tick a minute once a tab has been hidden for five -
 * turning a one-minute interval into a one-hour one without saying so. Alarms
 * live out here in the worker, which has no visibility state for Chrome to
 * throttle on, so the schedule holds whether the tab is in front or buried.
 *
 * The worker also drives the navigation itself, which keeps working when the
 * content script is not running at all - a tab discarded by Memory Saver is
 * simply pointed at the URL again and loads fresh.
 *
 * Exactly one alarm exists at a time. Every page load clears it and only a
 * page that means to keep watching arms a new one, so a booking form or a
 * paused tab cannot have a poll fire out from under it.
 */
const POLL_ALARM = "rktermin-poll";

/*
 * The worker's own safety net.
 *
 * armPoll is only ever called by the content script, so a navigation that never
 * runs one ends the loop with nothing scheduled and nobody to notice: a Chrome
 * network-error page, a portal 502, a tab discarded mid-load. None of those run
 * a content script, so none of them re-arm, and the watch is simply over.
 *
 * So the worker re-arms itself the moment it navigates. Any page that does run
 * the content script cancels it a second later - main() disarms unconditionally
 * before it even classifies the page - so what survives is exactly the case
 * this exists for: nothing ran.
 *
 * That unconditional disarm is also why this cannot fire under a booking. The
 * booking form runs the content script like any other page, and disarming is
 * the first thing it does.
 */
const WATCHDOG_MINUTES = 3;

/*
 * Re-arm after the worker navigates, and back off when it keeps having to.
 *
 * A fire that finds this flag still set means the load it was covering never
 * ran a content script. Once is a blip worth retrying in three minutes; five
 * in a row is an outage, a portal that is down, or a block delivered as a
 * dropped connection rather than as a page - and hammering any of those every
 * three minutes is the behaviour this whole file is careful to avoid. The page
 * that renders a block backs off 30 minutes; a block that never renders must
 * not get a better deal than that just because nothing was there to read it.
 */
async function armWatchdog(tabId, url, misses) {
  // Flat, deliberately: three minutes whether this is the first miss or the
  // twentieth. There is no dial for it any more and none is wanted.
  const wait = WATCHDOG_MINUTES;
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.storage.local.set({
    pollTarget: { tabId, url, dueAt: Date.now() + wait * 60000, watchdog: true, misses }
  });
  chrome.alarms.create(POLL_ALARM, { delayInMinutes: wait });
}

async function bumpStat(key) {
  const { stats = {} } = await chrome.storage.local.get("stats");
  stats[key] = (stats[key] || 0) + 1;
  if (!stats.since) stats.since = Date.now();
  if (key === "autoPolls") {
    if (!stats.firstPollAt) stats.firstPollAt = Date.now();
    stats.lastPollAt = Date.now();
  }
  await chrome.storage.local.set({ stats });
}

async function armPoll(tabId, url, minutes) {
  const wait = Math.max(0.5, Number(minutes) || 1);
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.storage.local.set({
    pollTarget: { tabId, url, dueAt: Date.now() + wait * 60000 }
  });
  chrome.alarms.create(POLL_ALARM, { delayInMinutes: wait });
}

async function disarmPoll() {
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.storage.local.remove("pollTarget");
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  const { pollTarget } = await chrome.storage.local.get("pollTarget");
  if (!pollTarget || !pollTarget.url) return;

  /* Still flagged as a watchdog means the previous navigation never ran a
   * content script - nothing was there to disarm it. So this is a retry into a
   * failure rather than a poll of a working page: it is not counted as one (the
   * popup's poll rate is meant to show whether checking is actually happening),
   * and each consecutive miss backs the next attempt off further. */
  const misses = pollTarget.watchdog ? (pollTarget.misses || 0) + 1 : 0;
  if (!misses) await bumpStat("autoPolls");
  try {
    await chrome.tabs.update(pollTarget.tabId, { url: pollTarget.url });
    // Cover the possibility that this load never runs a content script either.
    await armWatchdog(pollTarget.tabId, pollTarget.url, misses);
  } catch (_) {
    // The watched tab was closed. Nothing to poll, so stop rather than
    // re-arming against a tab id that no longer exists.
    await disarmPoll();
  }
});

/*
 * 2Captcha relay. Runs here rather than in the page so the request is governed
 * by host_permissions instead of the portal's CORS policy, and so the key is
 * never exposed to page scripts.
 *
 * Off unless the user supplies their own key. The distorted-text captcha is
 * misread often enough (~1 in 4 by the solver's own reporting) that the manual
 * path stays the reliable one; this exists for unattended runs.
 */
/*
 * What this portal's captchas look like, learned from the answers that turned
 * out to be right.
 *
 * The solver was being told `numeric: 0, min_len: 1` - "could be anything, at
 * least one character" - which is the least useful thing you can tell a human
 * squinting at a distorted image. Telling them it is exactly five digits is
 * worth a lot of accuracy, and accuracy is what governs throughput here: a
 * wrong answer costs a whole extra gate, solve and page load.
 *
 * Learned rather than configured, because the point is to run without being
 * told things. Only answers the portal actually accepted are counted, and the
 * length range only ever widens to fit what has been seen - so the hint cannot
 * assert something the evidence has already contradicted. Below HINT_AFTER
 * samples it says nothing at all rather than guessing from three examples.
 */
const HINT_AFTER = 8;

async function learnCaptchaShape(text) {
  const t = String(text || "").trim();
  if (!t) return;
  const { captchaShape = {} } = await chrome.storage.local.get("captchaShape");
  const seen = captchaShape.samples || 0;
  await chrome.storage.local.set({
    captchaShape: {
      min: seen ? Math.min(captchaShape.min, t.length) : t.length,
      max: seen ? Math.max(captchaShape.max, t.length) : t.length,
      // One answer with a letter in it settles the question for good.
      digits: seen ? !!captchaShape.digits && /^\d+$/.test(t) : /^\d+$/.test(t),
      samples: seen + 1
    }
  });
}

function captchaHints(shape) {
  if (!shape || (shape.samples || 0) < HINT_AFTER) return { numeric: "0", min_len: "1" };
  const min = Math.max(1, shape.min);
  const max = Math.max(min, shape.max);
  const what = shape.digits ? "digits" : "letters and digits";
  return {
    numeric: shape.digits ? "1" : "0",   // 1 = digits only
    min_len: String(min),
    max_len: String(max),
    // Workers see this next to the image. On a 300x50 picture holding six to
    // eight distorted characters, knowing how many to expect is most of the job.
    textinstructions: min === max
      ? `Enter the ${min} ${what} shown.`
      : `Enter the ${min}-${max} ${what} shown.`
  };
}

async function solveWith2Captcha(base64Image, key, shape) {
  const payload = base64Image.replace(/^data:image\/[a-z]+;base64,/i, "");

  const submit = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      key, method: "base64", body: payload, json: "1", ...captchaHints(shape)
    })
  }).then((r) => r.json());

  if (submit.status !== 1) throw new Error("2Captcha rejected the image: " + submit.request);
  const id = submit.request;

  // The service needs a few seconds of lead time before the first poll.
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(
      `https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=get&id=${id}&json=1`
    ).then((r) => r.json());

    if (res.status === 1) return { text: res.request, id };
    if (res.request !== "CAPCHA_NOT_READY") throw new Error("2Captcha error: " + res.request);
  }
  throw new Error("2Captcha timed out");
}

// Wrong solutions are reported back so the user is not billed for them.
async function report2CaptchaBad(id, key) {
  try {
    await fetch(`https://2captcha.com/res.php?key=${encodeURIComponent(key)}&action=reportbad&id=${id}`);
  } catch (_) { /* refund reporting is best-effort */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "getSettings":
          sendResponse({ ok: true, settings: await getSettings() });
          break;

        case "found": {
          await notifyFound(msg.dates);
          const sig = (msg.dates || []).map((d) => d.text).sort().join("|");
          await chrome.storage.local.set({
            lastResult: { at: Date.now(), state: "dates", dates: msg.dates },
            pushState: { sig, lastAt: Date.now(), count: 0 }
          });
          await pushToPhone(msg.dates || []);
          sendResponse({ ok: true });
          break;
        }

        case "status": {
          await chrome.storage.local.set({
            lastResult: { at: Date.now(), state: msg.state, dates: msg.dates || [] }
          });
          // content.js reports an unchanged set of openings as a plain status
          // every poll, which is the tick the repeat alert runs off.
          if (msg.state === "dates") await repeatPush(msg.dates || []);

          if (msg.state === "blocked") badge("!", "#c5221f");
          else if (msg.state === "booking" || msg.state === "day") badge("", "");
          else if (msg.state === "empty") badge("0", "#5f6368");
          else if (msg.state === "captcha") badge("?", "#b06000");
          else if (msg.state === "unknown") badge("·", "#5f6368");
          sendResponse({ ok: true });
          break;
        }

        case "solveCaptcha": {
          const { twoCaptchaKey } = await getSettings();
          if (!twoCaptchaKey) { sendResponse({ ok: false, error: "No 2Captcha API key configured" }); break; }
          const { captchaShape } = await chrome.storage.local.get("captchaShape");
          const solved = await solveWith2Captcha(msg.image, twoCaptchaKey, captchaShape);
          sendResponse({ ok: true, text: solved.text, id: solved.id });
          break;
        }

        case "armPoll": {
          const tabId = sender.tab && sender.tab.id;
          if (!tabId || !msg.url) { sendResponse({ ok: false, error: "no tab or url" }); break; }
          await armPoll(tabId, msg.url, msg.minutes);
          sendResponse({ ok: true });
          break;
        }

        case "disarmPoll":
          await disarmPoll();
          sendResponse({ ok: true });
          break;

        case "clearSession": {
          const done = await clearRecentCookies();
          // Only count a clear that actually happened. The counter exists to
          // answer "is recovery running", and it lied about that once already.
          if (done) await bumpStat("sessionResets");
          sendResponse({ ok: done, hours: CLEAR_WINDOW_HOURS });
          break;
        }

        case "testPush": {
          const s = await getSettings();
          if (!ntfyTopic(s.ntfyTopic)) {
            sendResponse({ ok: false, error: "Set a topic first - letters, numbers, - and _ only." });
            break;
          }
          await pushToPhone([], { test: true });
          sendResponse({ ok: true });
          break;
        }

        case "learnCaptcha":
          await learnCaptchaShape(msg.text);
          sendResponse({ ok: true });
          break;

        case "resetStats":
          // The learned shape goes with the counters. If a hint ever turns out
          // to be hurting, resetting is the way back to asking for nothing.
          await chrome.storage.local.set({ stats: { ...STATS, since: Date.now() } });
          await chrome.storage.local.remove("captchaShape");
          sendResponse({ ok: true });
          break;

        case "reportBadCaptcha": {
          const { twoCaptchaKey } = await getSettings();
          if (twoCaptchaKey && msg.id) await report2CaptchaBad(msg.id, twoCaptchaKey);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ ok: false, error: "Unknown message: " + msg.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
  return true; // keep the channel open for the async work above
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith("rktermin-")) return;
  chrome.tabs.create({ url: categoryUrl(await portalContext()) });
  chrome.notifications.clear(id);
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(["settings", "stats"]);
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULTS });
  if (!stored.stats) await chrome.storage.local.set({ stats: { ...STATS, since: Date.now() } });
});
