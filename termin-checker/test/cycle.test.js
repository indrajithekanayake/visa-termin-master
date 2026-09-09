/*
 * Walk a whole poll cycle across consecutive page loads, exactly as the browser
 * would: sessionStorage carries over, each load runs the real content.js.
 */
const { JSDOM, VirtualConsole } = require("jsdom"), fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const parserSrc = fs.readFileSync(path.join(ROOT,"parser.js"),"utf8");
const contentSrc = fs.readFileSync(path.join(ROOT,"content.js"),"utf8");
const SETTINGS = { locationCode:"colo", realmId:"1419", categoryId:"3728", fromDate:"", toDate:"",
  intervalMinutes:1, maxIntervalMinutes:60, adaptiveBackoff:false, activeStartHour:0,
  activeEndHour:0, autoReload:true, soundAlert:true, twoCaptchaKey:"", ntfyTopic:"t",
  ntfyRepeatMinutes:5, sweepPauseSeconds:0 };
let fails = 0;
const ok = (c,m) => { console.log((c?"  PASS ":"  FAIL ")+m); if(!c) fails++; };

/* The fixtures are all August. Re-stamp one to September to stand in for the
 * sibling month: only the heading and the arrows decide which month it is. */
function asMonth(file, mm) {
  let html = fs.readFileSync(path.join(ROOT,"test/fixtures",file),"utf8");
  return html.replace(/08\/2026/g, `${mm}/2026`)
             .replace(/dateStr=\d\d\.08\.2026/g, `dateStr=15.${mm}.2026`);
}

/* One page load. session = the tab's sessionStorage carried in and out. */
async function load(html, session, store, opts) {
  opts = opts || {};
  const dom = new JSDOM(html, {
    url:"https://service2.diplo.de/rktermin/extern/appointment_showMonth.do?locationCode=colo&realmId=1419&categoryId=3728",
    runScripts:"outside-only", pretendToBeVisual:true, virtualConsole:new VirtualConsole() });
  const w = dom.window, msgs = [];
  Object.keys(session).forEach(k => w.sessionStorage.setItem(k, session[k]));
  w.chrome = { runtime:{ onMessage: { addListener: () => {} }, sendMessage: async (m)=>{ msgs.push(m);
      return m.type==="getSettings"
        ? { ok:true, settings:{ ...SETTINGS, ...(opts.settings || {}) } } : { ok:true }; } },
    storage:{ local:{ get: async(k)=>{const ks=typeof k==="string"?[k]:k;const o={};
      (ks||[]).forEach(x=>{if(x in store)o[x]=store[x];});return o;}, set: async(o)=>{Object.assign(store,o);} } } };
  let navs = 0;
  dom.virtualConsole.on("jsdomError", e => { if(/navigation/.test(e.message)) navs++; });
  w.eval(parserSrc); w.eval(contentSrc);
  await new Promise(r=>setTimeout(r, opts.settle || 200));
  const out = {};
  for (let i=0;i<w.sessionStorage.length;i++){const k=w.sessionStorage.key(i);out[k]=w.sessionStorage.getItem(k);}
  return { msgs, navs, session: out,
           arm: msgs.filter(m=>m.type==="armPoll"),
           found: msgs.filter(m=>m.type==="found"),
           panel: (w.document.getElementById("rkt-root").shadowRoot.querySelector(".body").textContent||"")
                    .replace(/\s+/g," ").trim().slice(0,60) };
}

(async () => {
  console.log("CYCLE A — both months empty (the ordinary case)");
  const store = {};
  // The alarm fired and navigated the tab: the marker is set.
  let r = await load(asMonth("live_empty_month.html","08"), { rkt_auto:"1" }, store);
  ok(r.navs === 1, "load 1 (August, empty): hops straight to the sibling month");
  ok(r.arm.length === 0, "  and arms NO alarm — no 60s wait in between");
  ok(r.session.rkt_sweep && /08\.2026/.test(r.session.rkt_sweep), "  records August as visited");

  r = await load(asMonth("live_empty_month.html","09"), r.session, store);
  ok(r.navs === 0, "load 2 (September, empty): stops — both months now seen");
  ok(r.arm.length === 1, "  arms exactly ONE alarm for the next cycle");
  ok(r.arm[0].minutes === 1, `  at the configured ${r.arm[0].minutes}-minute interval`);
  ok(!r.session.rkt_sweep, "  and clears the sweep so the next cycle starts fresh");

  console.log("\nCYCLE B — the FIRST month has a slot");
  const store2 = {};
  r = await load(asMonth("live_german_dates.html","08"), { rkt_auto:"1" }, store2);
  ok(r.found.length === 1, "notifies immediately");
  ok(r.navs === 0, "  and does NOT walk on — you are not moved off the slot");
  ok(r.arm.length === 1, "  keeps watching that month (the slot can still be taken)");

  console.log("\nCYCLE C — first month empty, SECOND month has the slot");
  const store3 = {};
  r = await load(asMonth("live_empty_month.html","08"), { rkt_auto:"1" }, store3);
  ok(r.navs === 1 && r.arm.length === 0, "August empty: hops on without waiting");
  r = await load(asMonth("live_german_dates.html","09"), r.session, store3);
  ok(r.found.length === 1, "September has one: notifies on the same cycle");
  ok(r.navs === 0, "  stays put");
  ok(!r.session.rkt_sweep, "  sweep cleared");

  console.log("\nDIRECTION — landing on September walks BACK to August");
  const store4 = {};
  r = await load(asMonth("live_empty_month.html","09"), { rkt_auto:"1" }, store4);
  ok(r.navs === 1, "hops from September");
  ok(/09\.2026/.test(r.session.rkt_sweep||""), "  having recorded September as the one it came from");

  console.log("\nVISIBLE PAUSE — the beat that lets you read the first month");
  let r5 = await load(asMonth("live_empty_month.html","08"), { rkt_auto:"1" }, {},
    { settings:{ sweepPauseSeconds:1 }, settle:300 });
  ok(r5.navs === 0, "holds on the first month instead of flashing past");
  ok(r5.arm.length === 0, "  and arms no alarm while holding");

  let r6 = await load(asMonth("live_empty_month.html","08"), { rkt_auto:"1" }, {},
    { settings:{ sweepPauseSeconds:1 }, settle:1600 });
  ok(r6.navs === 1, "then walks on once the pause is up");

  let r7 = await load(asMonth("live_empty_month.html","08"), { rkt_auto:"1" }, {},
    { settings:{ sweepPauseSeconds:0 }, settle:300 });
  ok(r7.navs === 1, "a pause of 0 walks on immediately");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails?1:0);
})();
