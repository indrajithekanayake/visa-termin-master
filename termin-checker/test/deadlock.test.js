/*
 * Deadlock audit: for every page the tab can land on, does anything schedule a
 * next step without a human present?
 *
 * This is the property the whole extension rests on. A tab that stops silently
 * is worse than one that never started, because it looks like it is working.
 * Three states used to end the watch outright - a rate-limit block, a page the
 * parser could not read, and a gate whose image could not be extracted - and
 * nothing failed when they did.
 *
 * The other half matters just as much: the two booking states must NEVER
 * schedule anything, or the worker reloads the tab out from under a booking.
 */
const { JSDOM, VirtualConsole } = require("jsdom"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const parserSrc = fs.readFileSync(path.join(ROOT, "parser.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const S = { locationCode:"colo", realmId:"1419", categoryId:"3728", fromDate:"", toDate:"",
  intervalMinutes:1, autoReload:true, twoCaptchaKey:"KEY", ntfyTopic:"",
  sweepPauseSeconds:0, autoFailLimit:4 };

let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };
const fx = (f) => fs.readFileSync(path.join(ROOT, "test/fixtures", f), "utf8");

async function probe(html, { settings = {}, auto = false, solveErr = "ERROR_CAPTCHA_UNSOLVABLE",
                             failSettings = false, settle = 500 } = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(html, { url: "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do",
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, store = {}, msgs = [];
  let navs = 0;
  vc.on("jsdomError", (e) => { if (/navigation/i.test(e.message)) navs++; });
  w.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m) => { msgs.push(m);
      if (m.type === "getSettings") {
        return failSettings ? { ok: false } : { ok: true, settings: { ...S, ...settings } };
      }
      if (m.type === "solveCaptcha") return { ok: false, error: solveErr };
      return { ok: true }; } },
    storage: { local: { get: async (k) => { const ks = typeof k === "string" ? [k] : k; const o = {};
      (ks || []).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; },
      set: async (o) => { Object.assign(store, o); } } } };
  if (auto) w.sessionStorage.setItem("rkt_auto", "1");
  w.eval(parserSrc); w.eval(contentSrc);
  await new Promise((r) => setTimeout(r, settle));
  const arms = msgs.filter((m) => m.type === "armPoll");
  return { arms, navs, msgs, alive: arms.length > 0 || navs > 0 };
}

const BLOCKED = "<html><body><div id='content'><h1>Access denied</h1><p>Too many requests</p></div></body></html>";
const UNKNOWN = "<html><body><p>Sitzung abgelaufen. Bitte erneut beginnen.</p></body></html>";
const NO_IMAGE = fx("live_captcha.html").replace(/background:[^;"]*url\([^)]*\)/gi, "background:#fff");

(async () => {
  console.log("every state must schedule a next step");
  let r = await probe(fx("live_empty_month.html"));
  ok(r.alive, "empty month keeps watching");
  r = await probe(fx("live_german_dates.html"));
  ok(r.alive, "a month with openings keeps watching (the slot can still be taken)");
  r = await probe(fx("live_captcha.html"), { settle: 3400 });
  ok(r.alive, "a gate the solver fails on recovers rather than sitting there");

  r = await probe(NO_IMAGE, { settle: 3400 });
  ok(r.alive, "a gate whose image cannot be read comes back too");
  ok(r.navs === 1, "  by refetching after a pause, not by looping instantly");

  r = await probe(BLOCKED, { auto: true });
  ok(r.alive, "a rate-limit block backs off instead of ending the watch");
  ok(r.arms.length === 1 && r.arms[0].minutes === 3,
     `  after the block back-off (${r.arms.length ? r.arms[0].minutes : 0} min)`);
  ok(r.navs === 0, "  and does not hammer the portal while blocked");

  r = await probe(UNKNOWN, { auto: true });
  ok(r.alive, "a page the parser cannot read is re-checked, not surrendered to");
  ok(r.arms.length === 1 && r.arms[0].minutes === 1,
     `  at the normal interval (${r.arms.length ? r.arms[0].minutes : 0} min)`);

  console.log("\nbooking must never be interrupted — the other half of the property");
  r = await probe(fx("live_booking_form.html"));
  ok(!r.alive, "the booking form schedules nothing");
  r = await probe(fx("live_day_view.html"));
  ok(!r.alive, "the day view schedules nothing");

  console.log("\nand it does not fight you for the tab");
  r = await probe(UNKNOWN, { auto: false });
  ok(!r.alive, "a page you opened yourself is left alone");
  r = await probe(fx("live_empty_month.html"), { settings: { autoReload: false } });
  ok(!r.alive, "auto-reload off means off");

  console.log("\nthe alarm is cancelled before anything can go wrong");
  r = await probe(fx("live_booking_form.html"), { failSettings: true });
  ok(r.msgs[0] && r.msgs[0].type === "disarmPoll",
     "disarming is the very first thing a page does, ahead of reading settings");
  ok(!r.alive, "  so a settings read that fails still leaves no alarm armed");

  r = await probe(UNKNOWN, { auto: true });
  ok(r.msgs.some((m) => m.type === "status" && m.state === "unknown"),
     "an unreadable page tells the popup so, instead of leaving a stale reading");

  console.log("\nthe one state that genuinely needs you");
  r = await probe(fx("live_captcha.html"), { settings: { twoCaptchaKey: "" }, settle: 3400 });
  ok(!r.alive, "a gate with no 2Captcha key waits for typing - nothing else can pass it");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  // Countdown timers are still ticking by design; leave deliberately.
  process.exit(fails ? 1 : 0);
})();
