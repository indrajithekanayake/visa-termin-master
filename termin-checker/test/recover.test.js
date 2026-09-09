/*
 * Recovery, as asked for: four wrong captchas in a row clear the last 24 hours
 * of browser cookies, and checking continues.
 *
 * Two properties matter here, and they pull against each other.
 *
 * It must actually fire, every time, with no budget and no ceiling - the whole
 * point is that an unattended run recovers itself rather than parking on a gate.
 *
 * And it must fire ONLY on wrong answers. A blanket 24-hour wipe signs the user
 * out of every site they have used today, so a 2Captcha outage or an empty
 * balance - which clearing cookies cannot fix - must never trigger it. Those
 * two used to share a counter.
 */
const { JSDOM, VirtualConsole } = require("jsdom"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const parserSrc = fs.readFileSync(path.join(ROOT, "parser.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const BASE = { locationCode:"colo", realmId:"1419", categoryId:"3728", fromDate:"", toDate:"",
  intervalMinutes:1, maxIntervalMinutes:60, adaptiveBackoff:false, activeStartHour:0,
  activeEndHour:0, autoReload:true, soundAlert:true, twoCaptchaKey:"KEY", ntfyTopic:"",
  ntfyRepeatMinutes:5, sweepPauseSeconds:0, autoFailLimit:4, recoveryWaitMinutes:5,
  blockedWaitMinutes:3, sessionResetMinutes:0 };

let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

/* One page load. `wrong` renders the gate the way the portal renders it after a
 * rejected code; `solveErr` makes 2Captcha fail instead of answering. */
async function load(session, opts = {}) {
  const { solveOk = true, solveErr = null, settings = {}, wrong = false, settle = 200,
          fixture = "live_captcha.html" } = opts;
  let html = fs.readFileSync(path.join(ROOT, "test/fixtures/" + fixture), "utf8");
  if (wrong) html = html.replace("<body", "<body><p>Der eingegebene Text ist falsch.</p><div");

  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url: "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do",
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, store = {}, msgs = [];
  let navs = 0;
  vc.on("jsdomError", (e) => { if (/navigation/i.test(e.message)) navs++; });
  Object.keys(session).forEach((k) => w.sessionStorage.setItem(k, session[k]));

  w.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m) => {
      msgs.push(m);
      if (m.type === "getSettings") return { ok: true, settings: { ...BASE, ...settings } };
      if (m.type === "solveCaptcha") {
        return solveErr ? { ok: false, error: solveErr } : { ok: solveOk, text: "AB12CD", id: "1" };
      }
      if (m.type === "clearSession") return { ok: true, hours: 24 };
      return { ok: true }; } },
    storage: { local: { get: async (k) => { const ks = typeof k === "string" ? [k] : k; const o = {};
      (ks || []).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; },
      set: async (o) => { Object.assign(store, o); } } } };

  w.eval(parserSrc); w.eval(contentSrc);
  await new Promise((r) => setTimeout(r, settle));
  const out = {};
  for (let i = 0; i < w.sessionStorage.length; i++) {
    const k = w.sessionStorage.key(i); out[k] = w.sessionStorage.getItem(k);
  }
  return { session: out, navs, store, msgs,
    clears: msgs.filter((m) => m.type === "clearSession").length,
    solves: msgs.filter((m) => m.type === "solveCaptcha").length,
    arms: msgs.filter((m) => m.type === "armPoll"),
    panel: (w.document.getElementById("rkt-root").shadowRoot.querySelector(".body").textContent || "")
             .replace(/\s+/g, " ").trim() };
}

(async () => {
  console.log("counting wrong answers up to four");
  let r = await load({ rkt_autofail: "0", rkt_pending: "2captcha" }, { wrong: true });
  ok(r.session.rkt_autofail === "1", "a wrong answer counts");
  ok(r.clears === 0, "  and on its own clears nothing");
  ok(r.solves === 1, "  it just tries again");

  r = await load({ rkt_autofail: "2", rkt_pending: "2captcha" }, { wrong: true });
  ok(r.session.rkt_autofail === "3", "three in a row still only counts");
  ok(r.clears === 0, "  still nothing cleared");

  console.log("\nthe fourth clears the last 24 hours");
  r = await load({ rkt_autofail: "3", rkt_pending: "2captcha" }, { wrong: true });
  ok(r.clears === 1, "the fourth wrong answer clears cookies");
  ok(r.solves === 0, "  without spending another call first");
  ok(r.navs === 1, "  and reloads, so checking carries on");
  ok(r.session.rkt_autofail === "0", "  with the count back to zero");
  ok(/24 hours/.test(r.panel), "  and says so in the panel");

  console.log("\nno budget - it does this every time, for as long as the tab is open");
  for (let i = 0; i < 3; i++) {
    r = await load({ rkt_autofail: "3", rkt_pending: "2captcha" }, { wrong: true });
    ok(r.clears === 1, `  round ${i + 1} clears again`);
  }

  console.log("\nan accepted answer resets the count");
  /* Only the page AFTER a submit knows whether the answer was right, so the
   * success case has to be scored on a month page, not on the gate. */
  r = await load({ rkt_autofail: "3", rkt_pending: "2captcha", rkt_captcha_text: "AB12CD" },
    { fixture: "live_empty_month.html", settle: 250 });
  ok(r.session.rkt_autofail === "0", "one good answer wipes the run of failures");
  ok(r.clears === 0, "  and clears no cookies");
  ok((r.store.stats || {}).autoSolved === 1, "  and is counted as a solve");

  console.log("\nbut only while it is running unattended");
  /* The wipe reaches every site. With automatic re-checking off the user is at
   * the keyboard, and signing them out of other tabs mid-task because a captcha
   * failed four times is not something to do unasked. */
  r = await load({ rkt_autofail: "3", rkt_pending: "2captcha" },
    { wrong: true, settings: { autoReload: false } });
  ok(r.clears === 0, "auto-reload off clears nothing");
  ok(r.navs === 0, "  and navigates nowhere");
  ok(/Automatic re-checking is off/.test(r.panel), "  it says why, and points at the button");

  console.log("\nand neither does the page reload itself when told not to");
  r = await load({}, { solveErr: "ERROR_NO_SLOT_AVAILABLE",
                       settings: { autoReload: false }, settle: 3400 });
  ok(r.navs === 0, "a solver error does not reload the tab with auto-reload off");
  ok(r.clears === 0, "  and clears nothing");

  console.log("\nsolver errors follow the same rule");
  /* They used to be counted apart, on the argument that clearing cookies cannot
   * fix an empty balance. True, but one rule is easier to reason about, and the
   * error text is shown in the panel and counted in the popup either way. */
  r = await load({ rkt_autofail: "3" }, { solveErr: "ERROR_NO_SLOT_AVAILABLE", settle: 300 });
  ok(r.clears === 1, "a fourth failure clears, whether it was a wrong answer or an error");
  ok(r.navs === 1, "  and reloads");

  r = await load({}, { solveErr: "ERROR_NO_SLOT_AVAILABLE", settle: 200 });
  ok(r.clears === 0, "a single error clears nothing");
  ok(r.session.rkt_autofail === "1", "  it just counts");
  ok(r.navs === 0, "  and pauses before refetching rather than looping instantly");

  console.log("\nan error that answers instantly still cannot hot-loop");
  /* An empty balance comes back in milliseconds. Without a fixed pause between
   * attempts that is a reload loop against the portal, which is what actually
   * gets an IP blocked - so the beat applies even when the tab is hidden. */
  r = await load({}, { solveErr: "ERROR_ZERO_BALANCE", settle: 200 });
  ok(r.navs === 0, "no reload within the first 200ms");
  ok(/ZERO_BALANCE/.test(r.panel), "  and the real problem is named in the panel");
  r = await load({}, { solveErr: "ERROR_ZERO_BALANCE", settle: 3400 });
  ok(r.navs === 1, "  then exactly one reload, after the pause");

  console.log("\nstill counted as an API error for the popup");
  r = await load({}, { solveErr: "ERROR_ZERO_BALANCE", settle: 200 });
  ok((r.store.stats || {}).apiErrors === 1, "so a bad key is visible rather than guessed at");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
