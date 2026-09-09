/* Which pages arm a poll alarm, and which must never. */
const { JSDOM, VirtualConsole } = require("jsdom"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const parserSrc = fs.readFileSync(path.join(ROOT,"parser.js"),"utf8");
const contentSrc = fs.readFileSync(path.join(ROOT,"content.js"),"utf8");
const SETTINGS = { locationCode:"colo", realmId:"1419", categoryId:"3728", fromDate:"", toDate:"",
  intervalMinutes:1, autoReload:true, twoCaptchaKey:"", ntfyTopic:"" };
let fails = 0;
const ok = (c,m) => { console.log((c?"  PASS ":"  FAIL ")+m); if(!c) fails++; };

async function run(file, { autoMarker=false, settings={}, autoFails=0 } = {}) {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT,"test","fixtures",file),"utf8"), {
    url:"https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=colo&realmId=1419&categoryId=3728",
    runScripts:"outside-only", pretendToBeVisual:true, virtualConsole: vc });
  const w = dom.window, store = {}, msgs = [];
  w.chrome = { runtime:{ onMessage: { addListener: () => {} }, sendMessage: async (m)=>{ msgs.push(m);
      return m.type==="getSettings" ? { ok:true, settings:{...SETTINGS,...settings} } : { ok:true }; } },
    storage:{ local:{ get: async(k)=>{const ks=typeof k==="string"?[k]:k;const o={};
      (ks||[]).forEach(x=>{if(x in store)o[x]=store[x];});return o;}, set: async(o)=>{Object.assign(store,o);} } } };
  if (autoMarker) w.sessionStorage.setItem("rkt_auto","1");
  if (autoFails) w.sessionStorage.setItem("rkt_autofail", String(autoFails));
  w.eval(parserSrc); w.eval(contentSrc);
  await new Promise(r=>setTimeout(r,200));
  const arm = msgs.filter(m=>m.type==="armPoll");
  return { arm, disarms: msgs.filter(m=>m.type==="disarmPoll").length, w, msgs };
}

(async () => {
  console.log("pages that SHOULD keep watching");
  let r = await run("live_empty_month.html");
  ok(r.disarms >= 1, "empty month cancels any inherited alarm on load");
  ok(r.arm.length === 1, "then arms exactly one of its own");
  ok(r.arm[0].minutes === 1, `at the configured interval (${r.arm[0].minutes} min)`);
  ok(/showMonth\.do/.test(r.arm[0].url), "pointing at a month URL");

  r = await run("live_german_dates.html");
  ok(r.arm.length === 1, "a month with openings keeps watching (the slot can be taken)");

  console.log("\npages that MUST NOT be navigated away from");
  r = await run("live_booking_form.html");
  ok(r.disarms >= 1, "booking form cancels the alarm");
  ok(r.arm.length === 0, "and arms none — the worker cannot yank you off the form");

  r = await run("live_day_view.html");
  ok(r.disarms >= 1, "day view cancels the alarm");
  ok(r.arm.length === 0, "and arms none");

  r = await run("live_captcha.html");
  ok(r.arm.length === 0, "the gate arms none (it is waiting on you or 2Captcha)");

  console.log("\nauto-reload switched off");
  r = await run("live_empty_month.html", { settings:{ autoReload:false } });
  ok(r.arm.length === 0, "nothing is armed at all");

  console.log("\naround the clock - there is no window to sleep through");
  const h = new Date().getHours();
  r = await run("live_empty_month.html", {
    settings: { activeStartHour: (h + 2) % 24, activeEndHour: (h + 3) % 24 } });
  ok(r.arm.length === 1 && r.arm[0].minutes === 1,
     "old active-hours settings are ignored; it polls at the interval regardless");

  console.log("\nthe sweep hop does not arm — it navigates immediately");
  r = await run("live_empty_month.html", { autoMarker:true });
  ok(r.arm.length === 0, "mid-sweep the page hops instead of scheduling");
  ok(r.w.sessionStorage.getItem("rkt_auto") === "1", "and marks the hop automated");

  console.log("\nauto-solve fail limit is configurable");
  r = await run("live_captcha.html", { settings:{ twoCaptchaKey:"k", autoFailLimit:3 } });
  ok(r.msgs.some(m=>m.type==="solveCaptcha"), "auto-solves while under the limit");
  const dom2 = await run("live_captcha.html",
    { settings:{ twoCaptchaKey:"k", autoFailLimit:3 }, autoFails:3 });
  ok(!dom2.msgs.some(m=>m.type==="solveCaptcha"),
     "stops paying once 3 misses in a row are recorded");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails?1:0);
})();
