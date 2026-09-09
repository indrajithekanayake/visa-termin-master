/* Drives background.js's phone-alert path against stubbed chrome storage,
 * a stubbed fetch and a controllable clock. */
const fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = path.join(__dirname, "..", "background.js");

let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

function boot(settings) {
  const store = { settings }, pushes = [];
  let listener = null;
  const RealDate = Date;
  let clock = RealDate.now();

  const FakeDate = class extends RealDate {};
  FakeDate.now = () => clock;

  const chrome = {
    storage: { local: {
      get: async (keys) => {
        const ks = typeof keys === "string" ? [keys] : keys;
        const out = {};
        (ks || Object.keys(store)).forEach((k) => { if (k in store) out[k] = store[k]; });
        return out;
      },
      set: async (obj) => { Object.assign(store, obj); }
    }},
    runtime: {
      onMessage: { addListener: (fn) => { listener = fn; } },
      onInstalled: { addListener: () => {} },
      getURL: (p) => "chrome-extension://x/" + p
    },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    notifications: { create: async () => {}, clear: () => {}, onClicked: { addListener: () => {} } },
    tabs: { create: () => {}, update: async () => {} },
    alarms: { create: () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } }
  };

  const fetchStub = async (url, opts) => {
    pushes.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
  };

  vm.runInNewContext(fs.readFileSync(SRC, "utf8"),
    { chrome, fetch: fetchStub, Date: FakeDate, console, URLSearchParams });

  return {
    pushes, store,
    advance: (min) => { clock += min * 60000; },
    send: (msg) => new Promise((res) => listener(msg, {}, res))
  };
}

const DATES  = [{ text: "3. März 2026", iso: "2026-03-03" }];
const DATES2 = [{ text: "3. März 2026", iso: "2026-03-03" },
                { text: "4. März 2026", iso: "2026-03-04" }];
const SETTINGS = { locationCode: "colo", realmId: "1419", categoryId: "3728",
                   ntfyTopic: "rktermin-test-7f3a91c4" };

(async () => {
  console.log("repeat alert");
  let t = boot({ ...SETTINGS });

  await t.send({ type: "found", dates: DATES });
  ok(t.pushes.length === 1, "a new find pushes once");
  ok(t.pushes[0].body.priority === 5, "sent at max priority");
  ok(t.pushes[0].body.message.includes("März"), "umlaut survives into the payload");
  ok(!t.pushes[0].body.click.includes("jsessionid"), "click URL carries no session id");

  // Fixed at one minute now, with no dial: a poll inside that minute is silent.
  await t.send({ type: "status", state: "dates", dates: DATES });
  ok(t.pushes.length === 1, "a second poll in the same minute stays silent");

  t.advance(2);
  await t.send({ type: "status", state: "dates", dates: DATES });
  ok(t.pushes.length === 2, "repeats once the minute has passed");
  ok(t.pushes[1].body.message.startsWith("Still open"), "repeat is labelled as such");

  for (let i = 0; i < 200; i++) { t.advance(6); await t.send({ type: "status", state: "dates", dates: DATES }); }
  ok(t.pushes.length === 13, `caps out (1 find + 12 repeats), got ${t.pushes.length}`);

  await t.send({ type: "found", dates: DATES2 });
  ok(t.pushes.length === 14, "a changed set breaks through the cap");
  t.advance(6);
  await t.send({ type: "status", state: "dates", dates: DATES2 });
  ok(t.pushes.length === 15, "and its repeat counter starts fresh");

  console.log("\nno topic configured");
  t = boot({ ...SETTINGS, ntfyTopic: "" });
  await t.send({ type: "found", dates: DATES });
  t.advance(10);
  await t.send({ type: "status", state: "dates", dates: DATES });
  ok(t.pushes.length === 0, "nothing is sent");
  const r = await t.send({ type: "testPush" });
  ok(r && r.ok === false, "test alert reports the missing topic");

  console.log("\nother states");
  t = boot({ ...SETTINGS });
  await t.send({ type: "found", dates: DATES });
  t.advance(10);
  await t.send({ type: "status", state: "empty", dates: [] });
  await t.send({ type: "status", state: "blocked", dates: [] });
  ok(t.pushes.length === 1, "an empty or blocked poll never repeats");

  console.log(fails ? `\n${fails} failed` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
