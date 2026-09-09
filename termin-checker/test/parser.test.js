const { JSDOM } = require("jsdom");
const fs = require("fs");
const path = require("path");
const P = require("../parser.js");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log((ok ? "  PASS " : "  FAIL ") + name + (ok ? "" : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`));
  ok ? pass++ : fail++;
}
const doc = (html) => new JSDOM(html).window.document;

// 1. The real gate page, fetched live from the portal.
const live = doc(fs.readFileSync(require("path").join(__dirname,"fixtures","live_captcha.html"), "utf8"));
check("live page classifies as captcha", P.classify(live), P.STATE.CAPTCHA);
const img = P.extractCaptchaImage(live);
check("live captcha image extracted", !!(img && img.startsWith("data:image/")), true);
check("live captcha form found", !!P.findCaptchaForm(live), true);

// 2. Wrong captcha: the gate is re-rendered with the error text, so this must
//    NOT be reported as a plain gate (it would loop) nor as empty.
const errHtml = fs.readFileSync(require("path").join(__dirname,"fixtures","live_captcha.html"), "utf8")
  .replace("<body", "<body><p>Der eingegebene Text ist falsch.</p><div");
check("wrong-captcha page classifies as captcha_error", P.classify(doc(errHtml)), P.STATE.CAPTCHA_ERROR);

// 3. Month view with openings, shaped like the portal renders it.
const datesPage = `<body><div id="content">
  <h4>Termine am 21.08.2026</h4>
  <a class="arrow" href="extern/appointment_showDay.do?locationCode=colo&realmId=1419&categoryId=3728&dateStr=21.08.2026">09:00</a>
  <h4>Termine am 03.09.2026</h4>
  <a href="extern/appointment_showDay.do?dateStr=03.09.2026">10:30</a>
</div></body>`;
const d = P.analyse(doc(datesPage), {});
check("openings classify as dates", d.state, P.STATE.DATES);
check("both dates found, deduped and sorted", d.dates.map(x => x.text), ["21.08.2026", "03.09.2026"]);

// 4. analyse() reports every date it found - there is no window to filter by.
const win = P.analyse(doc(datesPage));
check("analyse reports all openings", win.dates.map(x => x.text), ["21.08.2026", "03.09.2026"]);

// 5. Empty month, via the portal's own wording.
check("no-appointments page classifies as empty",
  P.classify(doc(`<body><div id="content"><p>Unfortunately, there are no appointments available at this time. New appointments will be made available for booking at regular intervals.</p></div></body>`)),
  P.STATE.EMPTY);

// 6. Regression: if the portal rewords that sentence, an empty month must
//    still read as EMPTY rather than as an opening.
check("reworded empty month still classifies as empty",
  P.classify(doc(`<body><div id="content"><p>Es gibt derzeit nichts.</p></div></body>`)),
  P.STATE.EMPTY);

// 7. A page that is neither gate nor month view must not be called "empty".
check("unrelated page classifies as unknown",
  P.classify(doc(`<body><p>Session expired</p></body>`)), P.STATE.UNKNOWN);

// 8. Dates must be found from links alone, without any h4.
check("dates recovered from showDay links alone",
  P.extractDates(doc(`<body><div id="content"><a href="extern/appointment_showDay.do?dateStr=05.10.2026">x</a></div></body>`)).map(x => x.text),
  ["05.10.2026"]);

// 9. Month stepping must advance from the month being viewed, not from today,
//    or "Next month" becomes a no-op once you are past the current month.
check("steps one month forward", P.stepMonth("20.08.2026", 1), "01.09.2026");
check("steps across a year boundary", P.stepMonth("15.12.2026", 1), "01.01.2027");
check("anchors to the 1st so 31.01 + 1 is not March", P.stepMonth("31.01.2027", 1), "01.02.2027");
check("steps backwards", P.stepMonth("01.03.2027", -1), "01.02.2027");
check("falls back to the current month on junk input",
  /^01\.\d{2}\.\d{4}$/.test(P.stepMonth("", 0)), true);

// 10. Selectors the content script depends on must resolve on the real gate.
check("refresh-captcha button resolves on the live page",
  !!live.querySelector('input[name*="refreshCaptcha" i]'), true);
check("dateStr hidden field readable on the live page",
  (live.querySelector('input[name="dateStr"]') || {}).value, "20.08.2026");

// 11. Struts dispatches on the submit button NAME; picking the wrong one
//     cancels the flow instead of advancing it.
const skip = ["refreshcaptcha", "choose_category", "cancel", "abbrechen", "back", "zurueck"];
const usable = [...live.querySelectorAll('input[type="submit"]')]
  .filter((b) => b.name && !skip.some((s) => b.name.toLowerCase().includes(s)));
check("advancing submit button picked, not cancel/refresh",
  (usable.find((b) => b.name.includes("showMonth")) || usable[0] || {}).name,
  "action:appointment_showMonth");

// 12. Adaptive backoff: repeated empty checks must stretch the interval, and
//     must stay bounded. Request volume is what the portal limits, so this is
// 15. Around-the-clock default: equal start/end must never park the poller.

// 16. A rate-limit block must be distinguished from an empty month, or the one
//     signal that says "polling is costing you access" is silently swallowed.
check("block page classifies as blocked",
  P.classify(doc(`<body><h1>Access Denied</h1><p>Your IP address has been temporarily blocked.</p></body>`)),
  P.STATE.BLOCKED);
check("an ordinary empty month is not mistaken for a block",
  P.classify(doc(`<body><div id="content"><p>Unfortunately, there are no appointments available at this time.</p></div></body>`)),
  P.STATE.EMPTY);
check("the live gate is not mistaken for a block", P.classify(live), P.STATE.CAPTCHA);

// 17. Block markers must not fire on incidental text. A bare "429" or
//     "forbidden" would match session ids, category ids and ordinary prose,
//     stopping the poller for no reason.
check("an id containing 429 is not a block",
  P.classify(doc(`<body><div id="content"><p>Session 4429B rendered. No appointments available at this time.</p></div></body>`)),
  P.STATE.EMPTY);
check("real 429 wording still detected",
  P.classify(doc(`<body><p>429 Too Many Requests</p></body>`)), P.STATE.BLOCKED);
check("real 403 wording still detected",
  P.classify(doc(`<body><p>403 Forbidden</p></body>`)), P.STATE.BLOCKED);
check("live gate still not a block", P.classify(live), P.STATE.CAPTCHA);
check("second live page (realm 692) is a gate, not a block",
  P.classify(doc(require("fs").readFileSync(require("path").join(__dirname,"fixtures","live_realm692.html"),"utf8"))),
  P.STATE.CAPTCHA);

// 18. Ground truth: a real post-captcha month page with no openings, saved
//     from the live portal. This is the page the extension sees on almost
//     every poll, so its handling has to be exactly right.
const empty = doc(fs.readFileSync(path.join(__dirname, "fixtures", "live_empty_month.html"), "utf8"));
check("real empty month classifies as empty", P.classify(empty), P.STATE.EMPTY);
check("real empty month is past the captcha", !!P.findCaptchaForm(empty), false);

// The trap this page exposes: its month arrows AND its language switchers all
// point at appointment_showMonth.do carrying a full DD.MM.YYYY dateStr. A
// parser that scanned links or page text for dates would report three openings
// on a page that says there are none.
check("no phantom dates from month-nav and language links",
  P.extractDates(empty).map((x) => x.text), []);

// 19. Month navigation, read from the page rather than from today's date.
check("displayed month read from the MM/YYYY heading", P.displayedMonth(empty), "01.08.2026");
check("next-month arrow found by its image, not a class",
  /dateStr=20\.09\.2026/.test(P.monthNavHref(empty, 1)), true);
check("previous-month arrow found", /dateStr=20\.07\.2026/.test(P.monthNavHref(empty, -1)), true);
check("language switcher is not mistaken for a month arrow",
  /dateStr=23\.07\.2026/.test(P.monthNavHref(empty, 1)), false);
check("gate page has no month arrows to follow", P.monthNavHref(live, 1), null);
check("stepping from the displayed month lands on September",
  P.stepMonth(P.displayedMonth(empty), 1), "01.09.2026");

// 20. Offset 0 is the offset the polling loop uses on every cycle: it must
//     mean "this same month", never the previous-month arrow.
check("offset 0 yields no arrow, so the caller rebuilds the URL",
  P.monthNavHref(empty, 0), null);
check("offset 0 rebuilds to the same month, not backwards",
  P.stepMonth(P.displayedMonth(empty), 0), "01.08.2026");
check("offset -1 still resolves to the previous-month arrow",
  /dateStr=20\.07\.2026/.test(P.monthNavHref(empty, -1)), true);

// The saved fixture has Chrome-rewritten asset paths; the live page serves
// images/go-next.gif. The substring match has to work for both.
check("arrow matching works on live-style image paths",
  /dateStr=01\.10\.2026/.test(P.monthNavHref(doc(
    `<body><div id="content"><h2>09/2026</h2>
      <a href="extern/appointment_showMonth.do?dateStr=01.10.2026"><img src="images/go-next.gif"></a>
     </div></body>`), 1)), true);

// 21. GROUND TRUTH: a real month page WITH openings, from the live portal.
//     Until now this path was inferred from the Python version's structure.
const fx = (n) => doc(fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8"));
const withDates = fx("live_month_with_dates.html");
check("real month with openings classifies as dates", P.classify(withDates), P.STATE.DATES);
check("both real openings extracted from 'THURSDAY 20.08.2026' headings",
  P.extractDates(withDates).map((x) => x.text), ["20.08.2026", "27.08.2026"]);
check("openings carry their showDay link",
  /dateStr=20\.08\.2026/.test(P.extractDates(withDates)[0].href), true);
check("displayed month still readable alongside openings",
  P.displayedMonth(withDates), "01.08.2026");
const seen = P.analyse(withDates);
check("real openings are all reported", seen.dates.length > 0, true);

// 22. The day view must NOT read as a month listing. Its own links carry the
//     date already chosen, so a naive scan reports a phantom opening - and
//     then the poller navigates out of the booking flow mid-booking.
const dayView = fx("live_day_view.html");
check("real day view classifies as day, not dates", P.classify(dayView), P.STATE.DAY);
check("day view is recognised by its booking-form link", P.isDayView(dayView), true);
check("day view yields no openings once classified",
  P.analyse(dayView, {}).dates.map((x) => x.text), []);
check("a naive date scan WOULD have found a phantom here",
  P.extractDates(dayView).length > 0, true);
check("month view is not mistaken for a day view", P.isDayView(withDates), false);

// 23. The booking form carries a captcha whose submit button books the
//     appointment. Auto-solving it would submit empty personal details and
//     burn the slot, so it must never classify as an ordinary gate.
const booking = fx("live_booking_form.html");
check("real booking form classifies as booking, not captcha", P.classify(booking), P.STATE.BOOKING);
check("booking form detected by its visible personal fields", P.isBookingForm(booking), true);
check("month gate is NOT a booking form (same names, hidden)", P.isBookingForm(live), false);
check("booking form still exposes its captcha image for enlarging",
  !!P.analyse(booking, {}).captchaImage, true);
check("booking form reports no openings", P.analyse(booking, {}).dates.length, 0);

// 24. Re-checking must follow the page you are on, not your saved settings.
//     When the two disagree, reading settings navigates you into a different
//     appointment category entirely.
check("gate page identifies its own category from hidden inputs",
  P.pageContext(live), { locationCode: "colo", realmId: "1419", categoryId: "3728" });
check("empty month identifies its category from its links",
  P.pageContext(fx("live_empty_month.html")),
  { locationCode: "colo", realmId: "1419", categoryId: "3728" });
check("month with openings reports its own (different) category",
  P.pageContext(withDates), { locationCode: "colo", realmId: "692", categoryId: "4004" });
check("day view identifies its category", P.pageContext(dayView).realmId, "692");
check("booking form identifies its category", P.pageContext(booking).realmId, "692");
check("a page with no identifiers yields nulls to fall back on",
  P.pageContext(doc("<body><div id=\"content\"><p>nothing</p></div></body>")),
  { locationCode: null, realmId: null, categoryId: null });

// The two-month sweep: which months are in play, and the walk between them.
const PAIR = ["08.2026", "09.2026"];
check("sweep pair is this month and the next", P.sweepPair(new Date(2026, 7, 21)), PAIR);
check("sweep pair rolls over the year end", P.sweepPair(new Date(2026, 11, 31)), ["12.2026", "01.2027"]);
check("sweep pair moves with the clock, so a tab open past month end follows it",
  P.sweepPair(new Date(2026, 8, 1)), ["09.2026", "10.2026"]);
check("month key from a portal date string", P.monthKey("20.08.2026"), "08.2026");
check("month key from an unparseable string is empty", P.monthKey("nope"), "");

// Landing on either month walks to the other: this is the whole point, since
// which one the captcha drops you on is not ours to choose.
check("landing on August walks forward to September", P.sweepNext("08.2026", [], PAIR), "09.2026");
check("landing on September walks back to August", P.sweepNext("09.2026", [], PAIR), "08.2026");
check("cycle ends once the sibling has been seen", P.sweepNext("09.2026", ["08.2026"], PAIR), "");
check("cycle ends from the other direction too", P.sweepNext("08.2026", ["09.2026"], PAIR), "");
check("a month outside the pair is left alone", P.sweepNext("12.2026", [], PAIR), "");
check("an unreadable month heading stops the walk", P.sweepNext("", [], PAIR), "");
check("the walk never revisits a month it has already seen",
  P.sweepNext("08.2026", ["08.2026", "09.2026"], PAIR), "");

// The marker that separates a poll from your own clicking. It has to outlive
// the gate: a poll only reaches a month page by going through it.
check("a month page with dates spends the marker", P.spendsAutoMarker(P.STATE.DATES), true);
check("an empty month spends it too", P.spendsAutoMarker(P.STATE.EMPTY), true);
check("the gate does NOT spend it", P.spendsAutoMarker(P.STATE.CAPTCHA), false);
check("nor does a rejected captcha", P.spendsAutoMarker(P.STATE.CAPTCHA_ERROR), false);
check("nor a block page", P.spendsAutoMarker(P.STATE.BLOCKED), false);
check("nor the booking form", P.spendsAutoMarker(P.STATE.BOOKING), false);

// Walk the real sequence a poll takes, marker included: poll, gate, a wrong
// answer, gate again, then the month. The sweep must still fire at the end.
(function () {
  let marked = false, sawAuto = null;
  const load = (state) => {
    sawAuto = marked;                                  // read on every load
    if (P.spendsAutoMarker(state)) marked = false;     // spent only at a month
  };
  marked = true;                                       // the countdown fires
  [P.STATE.CAPTCHA, P.STATE.CAPTCHA_ERROR, P.STATE.CAPTCHA].forEach(load);
  check("marker survives the gate and a wrong answer", marked, true);
  load(P.STATE.EMPTY);
  check("the month page that follows a poll may walk", sawAuto, true);
  check("and the marker is spent there", marked, false);
  load(P.STATE.EMPTY);                                 // you press Re-check now
  check("a load you started may not walk", sawAuto, false);
})();

// The German original of the month view. The existing with-dates fixture is the
// same page auto-translated to English, so this locks in that detection keys on
// the date pattern and the showDay links rather than on any German or English
// wording - "Termine sind verfuegbar" and "Appointments are available" must
// both read as an opening.
const german = fx("live_german_dates.html");
check("German month view with an opening classifies as dates", P.classify(german), P.STATE.DATES);
check("the German opening is extracted with its date",
  P.extractDates(german).map((d) => d.text), ["27.08.2026"]);
check("it is not mistaken for a day view", P.isDayView(german), false);
check("nor for an empty month", P.classify(german) === P.STATE.EMPTY, false);
check("its booking link is carried through",
  /appointment_showDay\.do/.test(P.extractDates(german)[0].href), true);
check("a find key is produced, so the alert can fire",
  P.datesKey(P.extractDates(german)), "2026-08-27");
check("German page reports its own month", P.displayedMonth(german), "01.08.2026");
check("and its own category", P.pageContext(german).realmId, "692");
check("the sweep steps off it to the sibling month",
  P.sweepNext(P.monthKey(P.displayedMonth(german)), [], P.sweepPair(new Date(2026, 7, 21))),
  "09.2026");
check("following the portal's own next arrow from the German page",
  /dateStr=21\.09\.2026/.test(P.monthNavHref(german, 1)), true);
check("browser-injected attributes do not confuse it",
  german.querySelectorAll("[bis_skin_checked]").length > 0, true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
