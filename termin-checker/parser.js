/*
 * Parsing for the RK-Termin portal (service2.diplo.de/rktermin).
 *
 * Kept free of DOM-global access so it can be exercised against saved pages
 * in Node as well as running live in the content script. Every function takes
 * an explicit document.
 */
(function (root) {
  "use strict";

  // The portal answers a wrong captcha by re-rendering the gate with this
  // text. Both locales matter: the page language follows the mission, not the
  // browser, so an English-language post can still come back German.
  var CAPTCHA_ERROR_MARKERS = [
    "eingegebene text ist falsch",
    "entered text was wrong",
    "text you entered was wrong"
  ];

  // "No appointments" is only ever a secondary signal - see classify(). The
  // portal has reworded this string before, so nothing depends on matching it.
  var NO_APPOINTMENT_MARKERS = [
    "unfortunately, there are no appointments available",
    "no appointments available at this time",
    "keine termine frei",
    "sind leider keine termine frei"
  ];

  /* What an actual rate-limit block looks like, as opposed to a normal empty
   * month. Worth detecting separately: it is the only way to know whether
   * polling is costing you access, instead of guessing. */
  var BLOCKED_MARKERS = [
    "zugriff verweigert", "access denied", "too many requests",
    "temporarily blocked", "rate limit exceeded", "rate-limited",
    "ihre ip-adresse wurde", "your ip address has been",
    "403 forbidden", "429 too many", "503 service unavailable"
  ];

  var DATE_RE = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/;

  var STATE = {
    CAPTCHA: "captcha",
    CAPTCHA_ERROR: "captcha_error",
    DATES: "dates",
    EMPTY: "empty",
    DAY: "day",
    BOOKING: "booking",
    BLOCKED: "blocked",
    UNKNOWN: "unknown"
  };

  function pageText(doc) {
    return (doc.body ? doc.body.textContent || "" : "").toLowerCase();
  }

  function hasMarker(text, markers) {
    for (var i = 0; i < markers.length; i++) {
      if (text.indexOf(markers[i]) !== -1) return true;
    }
    return false;
  }

  /* The captcha form id changes between steps (…_month, …_day, …_form), so
   * find it by the field that is actually constant: the captchaText input. */
  function findCaptchaForm(doc) {
    var input = doc.querySelector('input[name="captchaText"]');
    return input ? input.form || input.closest("form") : null;
  }

  /* The image is a base64 JPEG inside an inline `background:` shorthand on a
   * div with a randomised id, wrapped in a non-standard <captcha> tag. Read the
   * style attribute rather than the id, and fall back to any data: URL in the
   * document if the markup shifts. */
  function extractCaptchaImage(doc) {
    var candidates = doc.querySelectorAll('captcha div, captcha *, [style*="data:image"]');
    for (var i = 0; i < candidates.length; i++) {
      var style = candidates[i].getAttribute("style") || "";
      var m = style.match(/url\(['"]?(data:image\/[a-z]+;base64,[^'")]+)['"]?\)/i);
      if (m) return m[1];
    }
    return null;
  }

  /*
   * The booking form carries a captcha too, but submitting it books the
   * appointment (action:appointment_addAppointment) rather than listing a
   * month. It is told apart from the month gate by its visible personal-detail
   * fields - on the month gate those same names exist but are hidden inputs.
   *
   * This distinction is load-bearing: auto-solving here would submit the
   * booking form with empty fields and burn the slot.
   */
  function isBookingForm(doc) {
    var probes = ["lastname", "firstname", "email"];
    for (var i = 0; i < probes.length; i++) {
      var el = doc.querySelector('input[name="' + probes[i] + '"]');
      if (el && (el.getAttribute("type") || "text").toLowerCase() !== "hidden") return true;
    }
    return false;
  }

  /* A day view lists time slots for one date and links on to the booking form.
   * It must never be mistaken for a month listing: its showDay links carry a
   * dateStr, so a naive date scan reports the day you already picked as a
   * fresh opening - and then polling navigates you out of the booking flow. */
  function isDayView(doc) {
    return !!doc.querySelector('a[href*="appointment_showForm.do"]');
  }

  function parseDate(str) {
    var m = String(str).match(DATE_RE);
    if (!m) return null;
    var day = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var year = parseInt(m[3], 10);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    return {
      day: day,
      month: month,
      year: year,
      text: pad(day) + "." + pad(month) + "." + year,
      // Sorts and compares correctly without timezone surprises.
      iso: year + "-" + pad(month) + "-" + pad(day)
    };
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  /*
   * Available days are rendered as <h4> headings inside div#content, each
   * reading like "Termine am 20.08.2026". Anchors to appointment_showDay.do
   * are collected as a second, independent source so a heading reword alone
   * cannot make a real opening look like an empty month.
   */
  function extractDates(doc) {
    var seen = Object.create(null);
    var out = [];

    function add(parsed, href) {
      if (!parsed) return;
      var existing = seen[parsed.iso];
      if (existing) {
        // Headings are read before links, so a date found via its <h4> arrives
        // without a href. Backfill it when the matching link turns up, or the
        // date renders as a dead link.
        if (!existing.href && href) existing.href = href;
        return;
      }
      parsed.href = href || null;
      seen[parsed.iso] = parsed;
      out.push(parsed);
    }

    var content = doc.querySelector("#content") || doc.body;
    if (!content) return out;

    var headings = content.querySelectorAll("h4");
    for (var i = 0; i < headings.length; i++) {
      add(parseDate(headings[i].textContent || ""));
    }

    var links = content.querySelectorAll('a[href*="appointment_showDay.do"]');
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute("href") || "";
      // The date lives in the dateStr query parameter; the link text is often
      // just a time or an arrow glyph.
      add(parseDate(decodeURIComponent(href)) || parseDate(links[j].textContent || ""), href);
    }

    out.sort(function (a, b) {
      return a.iso < b.iso ? -1 : a.iso > b.iso ? 1 : 0;
    });
    return out;
  }

  /*
   * Order matters. A wrong captcha re-renders the gate, so the error check has
   * to run before the plain-gate check. Dates are detected positively; "empty"
   * is what is left once no gate and no dates are present, which means a
   * reworded no-appointments string degrades to EMPTY rather than to a false
   * DATES.
   */
  function classify(doc) {
    var text = pageText(doc);
    var form = findCaptchaForm(doc);

    // Checked first: a block page carries neither gate nor dates, so it would
    // otherwise be reported as "no appointments" and hidden from you. Only
    // trusted when there is no gate, since the word "forbidden" could appear
    // in ordinary page furniture.
    if (!form && hasMarker(text, BLOCKED_MARKERS)) return STATE.BLOCKED;

    // Before any other captcha handling: a gate attached to the booking form is
    // not a search gate, and nothing about it may be automated.
    if (form && isBookingForm(doc)) return STATE.BOOKING;

    if (form && hasMarker(text, CAPTCHA_ERROR_MARKERS)) return STATE.CAPTCHA_ERROR;
    if (form) return STATE.CAPTCHA;

    // Checked before dates: the day view links on to the booking form and its
    // own showDay links carry the date you already chose.
    if (isDayView(doc)) return STATE.DAY;

    var dates = extractDates(doc);
    if (dates.length) return STATE.DATES;

    if (hasMarker(text, NO_APPOINTMENT_MARKERS)) return STATE.EMPTY;

    // A month view that rendered without a gate and without any date is an
    // empty month; anything else (an error page, a session timeout) is not
    // something to report as "no appointments".
    if (doc.querySelector("#content")) return STATE.EMPTY;
    return STATE.UNKNOWN;
  }

  /*
   * Step N months from a DD.MM.YYYY string, returning DD.MM.YYYY anchored to
   * the 1st. Anchoring matters: stepping one month from 31.01 would otherwise
   * roll into March.
   */
  function stepMonth(dateStr, offset) {
    var base = parseDate(dateStr);
    var year, month;
    if (base) {
      year = base.year; month = base.month;
    } else {
      var now = new Date();
      year = now.getFullYear(); month = now.getMonth() + 1;
    }
    var d = new Date(year, month - 1 + offset, 1);
    return "01." + pad(d.getMonth() + 1) + "." + d.getFullYear();
  }

  /*
   * The two months worth sweeping: the one we are in and the next.
   *
   * The portal exposes a short booking horizon - in practice the current month
   * and the one after it - and the captcha lands you on whichever of them the
   * session expired on. Checking the sibling covers the other.
   *
   * Derived from the clock on every poll rather than stored anywhere. An
   * anchor captured once and kept would, in a tab left open across a month
   * boundary, go on sweeping a month that is already in the past while never
   * looking at the one that just opened.
   */
  function monthKey(dateStr) {
    var p = parseDate(dateStr);
    return p ? pad(p.month) + "." + p.year : "";
  }

  function sweepPair(now) {
    var d = now ? new Date(now) : new Date();
    var first = "01." + pad(d.getMonth() + 1) + "." + d.getFullYear();
    return [monthKey(first), monthKey(stepMonth(first, 1))];
  }

  /*
   * When the "this load was the timer's doing" marker gets spent.
   *
   * Only on arrival at a month page. A poll travels poll -> gate -> (possibly a
   * wrong answer -> gate again) -> month, and clearing the marker on any of
   * those intermediate loads would strand the sweep: it would reach the month
   * it paid a captcha for and then decline to walk, because by then the load
   * looks manual.
   */
  function spendsAutoMarker(state) {
    return state === STATE.DATES || state === STATE.EMPTY;
  }

  /*
   * The next month in the cycle's walk, or "" when there is nothing left to
   * visit - either both have been seen, or the page is on a month outside the
   * pair because someone navigated there deliberately.
   */
  function sweepNext(here, visited, pair) {
    if (!here || pair.indexOf(here) === -1) return "";
    var seen = (visited || []).slice();
    if (seen.indexOf(here) === -1) seen.push(here);
    return pair.filter(function (m) { return seen.indexOf(m) === -1; })[0] || "";
  }

  /* Identity of a set of openings, so the same opening seen on three
   * consecutive polls counts as one find rather than three. */
  function datesKey(dates) {
    return (dates || []).map(function (d) { return d.iso; }).sort().join(",");
  }

  /*
   * The month the page is displaying, read from its own "MM/YYYY" heading.
   * This is the authoritative source: the captcha is submitted by POST, so the
   * resulting URL often carries no dateStr at all, and falling back to today's
   * date silently breaks month navigation.
   * Returns DD.MM.YYYY anchored to the 1st, or "" if no heading is found.
   */
  function displayedMonth(doc) {
    var headings = doc.querySelectorAll("#content h2, h2");
    for (var i = 0; i < headings.length; i++) {
      var m = (headings[i].textContent || "").trim().match(/^(\d{1,2})\/(\d{4})$/);
      if (m) {
        var mon = parseInt(m[1], 10);
        if (mon >= 1 && mon <= 12) return "01." + pad(mon) + "." + m[2];
      }
    }
    return "";
  }

  /*
   * The portal's own previous/next month links. They carry no class - they are
   * identified only by their arrow image - and following them is preferable to
   * rebuilding the URL, since it keeps the portal's own parameters intact.
   *
   * Note the language-switcher links point at appointment_showMonth.do too, and
   * carry a stale dateStr, so matching on the href alone would pick the wrong
   * link (and read its date as an opening).
   */
  function monthNavHref(doc, direction) {
    // Offset 0 means "this same month" - there is no arrow for that, and
    // falling through to the previous-month arrow would walk backwards one
    // month on every poll. Return null so the caller rebuilds the URL.
    if (!direction) return null;
    var needle = direction > 0 ? "go-next" : "go-previous";
    var links = doc.querySelectorAll('a[href*="appointment_showMonth.do"]');
    for (var i = 0; i < links.length; i++) {
      if (links[i].querySelector('img[src*="' + needle + '"]')) {
        return links[i].getAttribute("href");
      }
    }
    return null;
  }

  /*
   * Which appointment category the page in front of us belongs to.
   *
   * Read from the page rather than from settings so "re-check" always means
   * "re-check what I am looking at". Taking it from settings instead sends you
   * to a different category the moment the two disagree.
   *
   * Every stage carries these somewhere: the gate and the booking form in
   * hidden inputs, the month and day views in their own links.
   */
  function pageContext(doc) {
    var out = { locationCode: null, realmId: null, categoryId: null };
    var keys = ["locationCode", "realmId", "categoryId"];

    for (var i = 0; i < keys.length; i++) {
      var el = doc.querySelector('input[name="' + keys[i] + '"]');
      if (el && el.value) out[keys[i]] = el.value;
    }
    if (out.locationCode && out.realmId && out.categoryId) return out;

    var links = doc.querySelectorAll('a[href*="realmId="]');
    for (var j = 0; j < links.length; j++) {
      var href = links[j].getAttribute("href") || "";
      for (var k = 0; k < keys.length; k++) {
        if (out[keys[k]]) continue;
        var m = href.match(new RegExp(keys[k] + "=([^&]+)"));
        // Language switchers carry an empty dateStr but valid ids, so an empty
        // capture is skipped rather than accepted.
        if (m && m[1]) out[keys[k]] = decodeURIComponent(m[1]);
      }
      if (out.locationCode && out.realmId && out.categoryId) break;
    }
    return out;
  }

  function analyse(doc) {
    var state = classify(doc);
    var dates = state === STATE.DATES ? extractDates(doc) : [];
    return {
      state: state,
      dates: dates,
      captchaImage: state === STATE.CAPTCHA || state === STATE.CAPTCHA_ERROR || state === STATE.BOOKING
        ? extractCaptchaImage(doc)
        : null,
      captchaWrong: hasMarker(pageText(doc), CAPTCHA_ERROR_MARKERS)
    };
  }

  root.RKTerminParser = {
    STATE: STATE,
    classify: classify,
    analyse: analyse,
    extractDates: extractDates,
    extractCaptchaImage: extractCaptchaImage,
    findCaptchaForm: findCaptchaForm,
    isBookingForm: isBookingForm,
    isDayView: isDayView,
    parseDate: parseDate,
    stepMonth: stepMonth,
    monthKey: monthKey,
    sweepPair: sweepPair,
    sweepNext: sweepNext,
    spendsAutoMarker: spendsAutoMarker,
    datesKey: datesKey,
    displayedMonth: displayedMonth,
    pageContext: pageContext,
    monthNavHref: monthNavHref
  };

  if (typeof module !== "undefined" && module.exports) module.exports = root.RKTerminParser;
})(typeof globalThis !== "undefined" ? globalThis : this);
