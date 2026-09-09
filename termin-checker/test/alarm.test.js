/*
 * The poll alarm: arming, cancelling, and what happens when it fires.
 *
 * This is what replaced the in-page countdown, so the properties that matter
 * are the safety ones - that exactly one alarm exists, that it belongs to the
 * page that armed it, and that a page which is mid-booking has none.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = path.join(__dirname, "..", "background.js");

let pass = 0, fail = 0;
const check = (name, ok) => {
  console.log((ok ? "  PASS " : "  FAIL ") + name);
  ok ? pass++ : fail++;
};

function boot(settings) {
  const store = settings ? { settings } : {};
  const alarms = new Map(), navigations = [], removed = [];
  /* Shaped like the real thing, because the shape is what broke it:
   * - JSESSIONID is scoped to the app's context path, so a query about "/"
   *   never sees it;
   * - cookieconsent sits on the PARENT domain, which a {domain} query misses;
   * - portalPrefs sits deeper than the pages themselves, which a {url} query
   *   misses.
   * Only asking both ways finds all three. */
  const sweeps = [];          // browsingData.removeCookies calls
  let onMessage = null, onAlarm = null;
  const chrome = {
    storage: { local: {
      get: async (k) => { const ks = typeof k === "string" ? [k] : k; const o = {};
        (ks || Object.keys(store)).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; },
      set: async (o) => { Object.assign(store, o); },
      remove: async (k) => { (typeof k === "string" ? [k] : k).forEach((x) => delete store[x]); } } },
    runtime: { onMessage: { addListener: (f) => { onMessage = f; } },
               onInstalled: { addListener: () => {} }, getURL: (p) => p },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    notifications: { create: async () => {}, clear: () => {}, onClicked: { addListener: () => {} } },
    tabs: { create: () => {},
            update: async (id, o) => {
              if (id === 999) throw new Error("No tab with id: 999");
              navigations.push({ id, url: o.url });
            } },
    alarms: { create: (name, o) => alarms.set(name, o),
              clear: async (name) => alarms.delete(name),
              onAlarm: { addListener: (f) => { onAlarm = f; } } },
    tabs: { create: () => {},
            update: async (id, o) => {
              if (id === 999) throw new Error("No tab with id: 999");
              navigations.push({ id, url: o.url });
            } },
    alarms: { create: (name, o) => alarms.set(name, o),
              clear: async (name) => alarms.delete(name),
              onAlarm: { addListener: (f) => { onAlarm = f; } } },
    browsingData: { removeCookies: async (opts) => { sweeps.push(opts); } }
  };
  vm.runInNewContext(fs.readFileSync(SRC, "utf8"),
    { chrome, fetch: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({}) }),
      console, URLSearchParams, Date });
  return {
    store, alarms, navigations, sweeps,
    send: (msg, tabId = 7) => new Promise((r) => onMessage(msg, { tab: { id: tabId } }, r)),
    fire: () => onAlarm({ name: "rktermin-poll" })
  };
}

const URL_AUG = "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?dateStr=01.08.2026";
const URL_SEP = "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?dateStr=01.09.2026";

(async () => {
  console.log("arming");
  let t = boot();
  let r = await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  check("armPoll succeeds", r && r.ok === true);
  check("one alarm exists", t.alarms.size === 1);
  check("scheduled for the requested delay", t.alarms.get("rktermin-poll").delayInMinutes === 1);
  check("the target url is recorded", t.store.pollTarget.url === URL_AUG);
  check("against the calling tab", t.store.pollTarget.tabId === 7);

  console.log("\nre-arming replaces rather than stacks");
  await t.send({ type: "armPoll", url: URL_SEP, minutes: 3 });
  check("still exactly one alarm", t.alarms.size === 1);
  check("now pointing at the newer url", t.store.pollTarget.url === URL_SEP);
  check("with the newer delay", t.alarms.get("rktermin-poll").delayInMinutes === 3);

  console.log("\nfiring");
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  await t.fire();
  check("navigates the watched tab", t.navigations.length === 1);
  check("to the url that was armed", t.navigations[0].url === URL_AUG);
  check("in the tab that armed it", t.navigations[0].id === 7);
  check("and counts the poll", (t.store.stats || {}).autoPolls === 1);
  check("firstPollAt is stamped for the runtime display", !!(t.store.stats || {}).firstPollAt);

  console.log("\nthe watchdog - a load that never runs a content script");
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  await t.fire();
  check("after navigating, the worker re-arms itself", t.alarms.size === 1);
  check("  at the watchdog delay, not the poll interval",
    t.alarms.get("rktermin-poll").delayInMinutes === 3);
  check("  aimed at the same tab and url", t.store.pollTarget.url === URL_AUG);
  // A network error page or a discarded tab runs no content script, so nothing
  // disarms this - and the watch resumes instead of ending there.
  await t.fire();
  check("  and fires again if nothing cancelled it", t.navigations.length === 2);
  // Any page that DOES run the content script cancels it, which is what keeps
  // the watchdog away from a booking in progress.
  // Flat by default: the ceiling is blockedWaitMinutes, which is 3, so there is
  // nothing to escalate into. One number governs both kinds of block.
  for (let i = 0; i < 4; i++) await t.fire();
  check("  holding at the 3-minute retry rather than stretching out",
    t.alarms.get("rktermin-poll").delayInMinutes === 3);
  // The popup's poll rate has to mean "checking is happening". Counting retries
  // into a dead network would make an outage look like a healthy run.
  check("  and a retry into a failure is not counted as a poll",
    (t.store.stats || {}).autoPolls === 1);

  await t.send({ type: "disarmPoll" });
  check("  while a page that loads normally cancels it", t.alarms.size === 0);

  // Flat by design and no longer configurable: three minutes, always.
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  for (let i = 0; i < 6; i++) await t.fire();
  check("six misses later it is still three minutes",
    t.alarms.get("rktermin-poll").delayInMinutes === 3);

  console.log("\ndisarming - this is what protects a booking in progress");
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  await t.send({ type: "disarmPoll" });
  check("the alarm is gone", t.alarms.size === 0);
  check("and so is its target", t.store.pollTarget === undefined);
  await t.fire();   // a stale firing must do nothing
  check("a stale alarm firing navigates nothing", t.navigations.length === 0);
  check("and does not count a poll", ((t.store.stats || {}).autoPolls || 0) === 0);

  console.log("\nthe watched tab was closed");
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 }, 999);
  await t.fire();
  check("no navigation happens", t.navigations.length === 0);
  check("and the alarm disarms itself rather than retrying forever", t.alarms.size === 0);

  console.log("\nbad input");
  t = boot();
  r = await t.send({ type: "armPoll", url: "", minutes: 1 });
  check("arming with no url is refused", r && r.ok === false);
  check("and arms nothing", t.alarms.size === 0);
  r = await t.send({ type: "armPoll", url: URL_AUG, minutes: 0.1 });
  check("a sub-30-second delay is floored to 0.5min, not passed through",
    t.alarms.get("rktermin-poll").delayInMinutes === 0.5);

  console.log("\nthe cookie wipe");
  t = boot();
  const r2 = await t.send({ type: "clearSession" });
  check("clearing works", r2 && r2.ok === true);
  check("  it is one browsingData call, not a per-cookie loop", t.sweeps.length === 1);
  // A blanket 24h wipe was asked for explicitly, after every narrower form -
  // by name, path, domain, store, and origin - removed nothing on this portal.
  check("  covering the last 24 hours",
    Math.abs(t.sweeps[0].since - (Date.now() - 24 * 3600 * 1000)) < 5000);
  check("  and not limited to one site, which is the point and the cost",
    t.sweeps[0].origins === undefined);
  check("  counted", (t.store.stats || {}).sessionResets === 1);

  console.log("\na poll never wipes on its own");
  t = boot();
  await t.send({ type: "armPoll", url: URL_AUG, minutes: 1 });
  await t.fire();
  check("polling clears nothing - only four failures do", t.sweeps.length === 0);
  check("  and the poll itself still runs", t.navigations.length === 1);


  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
