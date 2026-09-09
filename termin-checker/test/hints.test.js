/*
 * What the solver is told about these captchas, and where it comes from.
 *
 * It was told `numeric: 0, min_len: 1` - "anything, at least one character" -
 * which is the least useful thing you can say to someone reading a distorted
 * image. Accuracy governs throughput here (a wrong answer costs a whole extra
 * gate, solve and page load), so the hint is worth getting right.
 *
 * The property that matters: the hint may only ever assert what correct answers
 * have actually shown, and must stay silent until there are enough of them.
 */
const fs = require("fs"), vm = require("vm"), path = require("path");
const SRC = path.join(__dirname, "..", "background.js");

let fails = 0;
const ok = (c, m) => { console.log((c ? "  PASS " : "  FAIL ") + m); if (!c) fails++; };

function boot() {
  const store = { settings: {} };
  const sent = [];
  let listener = null;
  const chrome = {
    storage: { local: {
      get: async (keys) => { const ks = typeof keys === "string" ? [keys] : keys; const out = {};
        (ks || Object.keys(store)).forEach((k) => { if (k in store) out[k] = store[k]; }); return out; },
      set: async (o) => { Object.assign(store, o); },
      remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]); } } },
    alarms: { create: () => {}, clear: async () => {}, onAlarm: { addListener: () => {} } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
    notifications: { create: async () => {}, onClicked: { addListener: () => {} }, clear: () => {} },
    cookies: { getAll: async () => [], remove: async () => {} },
    tabs: { create: () => {}, update: async () => {} },
    runtime: { onMessage: { addListener: (f) => { listener = f; } },
               onInstalled: { addListener: () => {} }, getURL: () => "" }
  };
  // in.php records what we asked for; res.php answers immediately.
  const fetchStub = async (url, opts) => {
    if (String(url).includes("in.php")) {
      sent.push(Object.fromEntries(new URLSearchParams(opts.body)));
      return { json: async () => ({ status: 1, request: "ID1" }) };
    }
    return { json: async () => ({ status: 1, request: "54321" }) };
  };
  vm.runInNewContext(fs.readFileSync(SRC, "utf8"),
    { chrome, fetch: fetchStub, console, setTimeout: (f) => f(), Date, URLSearchParams, URL });
  const send = (msg) => new Promise((res) => listener(msg, {}, res));
  return { store, sent, send };
}

(async () => {
  console.log("before there is evidence, it asserts nothing");
  let t = boot();
  t.store.settings = { twoCaptchaKey: "K" };
  for (let i = 0; i < 7; i++) await t.send({ type: "learnCaptcha", text: "12345" });
  await t.send({ type: "solveCaptcha", image: "data:image/jpeg;base64,AAA" });
  ok(t.sent[0].min_len === "1" && t.sent[0].numeric === "0",
     "seven samples is not enough - still asks for nothing");
  ok(t.store.captchaShape.samples === 7, "  but it is counting them");

  console.log("\nonce there is, it says exactly what it has seen");
  await t.send({ type: "learnCaptcha", text: "12345" });
  await t.send({ type: "solveCaptcha", image: "data:image/jpeg;base64,AAA" });
  const h = t.sent[1];
  ok(h.min_len === "5" && h.max_len === "5", `exactly five characters (${h.min_len}-${h.max_len})`);
  ok(h.numeric === "1", "  and digits only, which is worth real accuracy");

  console.log("\nit can never assert something the evidence contradicts");
  t = boot();
  t.store.settings = { twoCaptchaKey: "K" };
  for (let i = 0; i < 8; i++) await t.send({ type: "learnCaptcha", text: "1234" });
  await t.send({ type: "learnCaptcha", text: "AB7654" });
  await t.send({ type: "solveCaptcha", image: "data:image/jpeg;base64,AAA" });
  ok(t.sent[0].min_len === "4" && t.sent[0].max_len === "6",
     `one longer answer widens the range rather than being ignored (${t.sent[0].min_len}-${t.sent[0].max_len})`);
  ok(t.sent[0].numeric === "0", "  and one answer with letters settles the charset for good");

  console.log("\nonly answers the portal accepted are learned from");
  t = boot();
  await t.send({ type: "learnCaptcha", text: "   " });
  ok(!t.store.captchaShape, "a blank answer teaches nothing");

  console.log("\nresetting the counters forgets it too");
  t = boot();
  t.store.settings = { twoCaptchaKey: "K" };
  for (let i = 0; i < 9; i++) await t.send({ type: "learnCaptcha", text: "12345" });
  await t.send({ type: "resetStats" });
  ok(!t.store.captchaShape, "so a hint learned from a bad run is recoverable");
  await t.send({ type: "solveCaptcha", image: "data:image/jpeg;base64,AAA" });
  ok(t.sent[0].min_len === "1", "  back to asking for nothing");

  console.log(fails ? `\n${fails} FAILED` : "\nall passed");
  process.exit(fails ? 1 : 0);
})();
