/*
 * The degraded path: the worker cannot be reached, so the page has to drive the
 * poll itself.
 *
 * The README promises this ("If the worker cannot be reached the page falls
 * back to driving the poll itself, throttling and all - degraded, but not
 * stopped") and nothing exercised it. The safety property is the other half:
 * when the alarm IS armed the page must not navigate too, or a poll fires twice.
 *
 * The wait is a minute at its shortest, so the clock is pushed forward rather
 * than waited out.
 */
const { JSDOM, VirtualConsole } = require("jsdom"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const parserSrc = fs.readFileSync(path.join(ROOT, "parser.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const SETTINGS = { locationCode:"colo", realmId:"1419", categoryId:"3728", fromDate:"", toDate:"",
  intervalMinutes:1, maxIntervalMinutes:60, adaptiveBackoff:false, activeStartHour:0,
  activeEndHour:0, autoReload:true, soundAlert:true, twoCaptchaKey:"", ntfyTopic:"",
  ntfyRepeatMinutes:5, sweepPauseSeconds:0 };
let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

async function run({ armOk }) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "test/fixtures/live_empty_month.html"), "utf8"), {
    url: "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=colo&realmId=1419&categoryId=3728",
    runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, store = {}, msgs = [];
  let navs = 0;
  vc.on("jsdomError", (e) => { if (/navigation/i.test(e.message)) navs++; });

  w.chrome = { runtime: { onMessage: { addListener: () => {} }, sendMessage: async (m) => { msgs.push(m);
      if (m.type === "getSettings") return { ok: true, settings: SETTINGS };
      if (m.type === "armPoll") return { ok: armOk };
      return { ok: true }; } },
    storage: { local: { get: async (k) => { const ks = typeof k === "string" ? [k] : k; const o = {};
      (ks || []).forEach((x) => { if (x in store) o[x] = store[x]; }); return o; },
      set: async (o) => { Object.assign(store, o); } } } };

  w.eval(parserSrc); w.eval(contentSrc);
  await new Promise((r) => setTimeout(r, 250));

  // Push the clock past the deadline. The countdown reads the clock on every
  // tick rather than counting them, so this is all it takes.
  const realNow = w.Date.now.bind(w.Date);
  w.Date.now = () => realNow() + 61000;
  await new Promise((r) => setTimeout(r, 1300));

  return { navs, store, armed: msgs.filter((m) => m.type === "armPoll").length };
}

(async () => {
  console.log("worker unreachable — the page polls itself");
  let r = await run({ armOk: false });
  ok(r.armed === 1, "it tried to hand the schedule to the worker");
  ok(r.navs === 1, "  and on refusal drove the poll itself when the time came");
  ok((r.store.stats || {}).autoPolls === 1, "  counting it as an unattended poll");

  console.log("\nworker armed it — the page must NOT also navigate");
  r = await run({ armOk: true });
  ok(r.armed === 1, "handed off to the worker");
  ok(r.navs === 0, "  and stayed put: the alarm owns the navigation");
  ok(!(r.store.stats || {}).autoPolls, "  no double count either");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
