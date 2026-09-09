/*
 * Runs inside the portal page. Everything happens here rather than in the
 * service worker because the captcha is bound to the ;jsessionid the page was
 * served with - solving it anywhere else lands in a different session.
 */
(function () {
  "use strict";

  const P = globalThis.RKTerminParser;
  const HOST = "https://service2.diplo.de/rktermin/extern/appointment_showMonth.do";

  /* Only ever a seed. Any page you open overwrites it, so it matters solely on
   * the very first load before anything has been seen. */
  const DEFAULT_PORTAL = { locationCode: "colo", realmId: "1419", categoryId: "3728" };

  let settings = null;
  let countdownTimer = null;
  let panel = null;
  let paused = false;
  let shadow = null;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({ ok: false }));

  /* Reloading or updating the extension orphans this script in every page that
   * was already open: its next call into chrome.* rejects with "Extension
   * context invalidated". Harmless in itself - the tab only needs a reload -
   * but every unhandled one is reported on the extensions page, where it buries
   * the errors that do matter. */
  const isOrphaned = (err) => /Extension context invalidated|Receiving end does not exist|message port closed/i
    .test(String(err && err.message ? err.message : err));

  /* Say so in the panel rather than leaving a dead countdown with no
   * explanation. Polling has already stopped by the time this runs, which is
   * the behaviour we want: an orphaned tab that kept reloading would spend
   * portal requests the extension can no longer see, and request volume is
   * what gets you blocked. */
  const ORPHAN_MSG = "Extension was reloaded — reload this page to resume watching.";

  function noteOrphaned() {
    if (!shadow) return;
    const b = body();
    if (!b) return;
    // Mid-countdown there is a countdown line to replace; if the failure came
    // earlier than that, the body is still empty and gets the notice instead.
    const el = b.querySelector(".cd");
    if (el) el.innerHTML = `<span class="hint">${ORPHAN_MSG}</span>`;
    else b.innerHTML = `<div class="msg">${ORPHAN_MSG}</div>`;
  }

  /* Async work started without being awaited still needs a rejection handler,
   * or an orphaned tab reports one of the above for every timer tick. */
  const detach = (promise) => promise.catch((err) => {
    if (isOrphaned(err)) { noteOrphaned(); return; }
    console.error("[RK-Termin]", err);
  });

  /* Whether this page load was the timer's doing rather than yours. Only an
   * automated load may walk on to the sibling month: a sweep that also fired
   * after a click would make "Next month" bounce you straight back, and the two
   * months it wants are exactly the two you are most likely to be browsing.
   *
   * A poll reaches a month page via the gate - poll, gate, maybe a wrong
   * answer, then the month - so the marker has to outlive those intermediate
   * loads. It is cleared on arrival at a month page and nowhere else. */
  const AUTO_KEY = "rkt_auto";
  const markAuto = () => sessionStorage.setItem(AUTO_KEY, "1");
  let wasAutoLoad = false;

  /* A wrong answer re-renders the gate, which would trigger another solve. With
   * a bad key, a degraded service, or a font the solver simply cannot read,
   * that is an unbounded loop of paid API calls and portal requests. Cap the
   * consecutive failures and hand back to manual entry. */
  const autoFailLimit = () => Math.max(1, Number(settings.autoFailLimit) || 3);
  const autoFails = () => Number(sessionStorage.getItem("rkt_autofail") || 0);
  const setAutoFails = (n) => sessionStorage.setItem("rkt_autofail", String(n));

  /* Each poll is a fresh page load, so counters live in storage and every
   * change is a read-modify-write. */
  async function bump(key, n) {
    const { stats = {} } = await chrome.storage.local.get("stats");
    stats[key] = (stats[key] || 0) + (n || 1);
    if (!stats.since) stats.since = Date.now();
    if (key === "autoPolls") {
      if (!stats.firstPollAt) stats.firstPollAt = Date.now();
      stats.lastPollAt = Date.now();
    }
    await chrome.storage.local.set({ stats });
  }

  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  /* m:ss, or h:mm:ss once there is an hour on the clock. */
  function clockText(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return (h ? h + ":" + pad2(m) : String(m)) + ":" + pad2(seconds % 60);
  }

  /*
   * The one countdown. Three callers want the same shape - a sweep pause, the
   * poll wait, and the wait after a run of captcha failures - and having it
   * written three times meant three places to look when a timer misbehaved.
   *
   * Seconds left are always read from the clock, never counted in ticks. Chrome
   * delivers about one tick a minute to a hidden tab, so a per-tick counter
   * reports time that has not passed; a clock reading redraws late but is never
   * wrong. This is the same reason the poll itself lives in the worker.
   *
   * onDone is optional, and that is the safety property: when the worker's
   * alarm is doing the navigating these lines are only a display and must not
   * navigate themselves, or the page and the alarm both fire.
   */
  function countdown(el, dueAt, paint, onDone) {
    stopCountdown();
    const tick = () => {
      // The panel was closed, or replaced by another render. Nothing is being
      // read, so stop - including any navigation that was riding on it.
      if (!el || !el.isConnected) return stopCountdown();
      const left = Math.max(0, Math.round((dueAt - Date.now()) / 1000));
      paint(left);
      if (left > 0) return;
      stopCountdown();
      if (onDone) onDone();
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* Every navigation goes through here so a pending auto-reload can never fire
   * mid-navigation and undo it.
   *
   * It also records why we are moving. The alarm navigates the tab without
   * running any of this, so the marker it needs is set when the alarm is armed;
   * that would leave it set if you then clicked somewhere yourself, and the
   * sweep would treat your click as a poll. Clearing it here on every manual
   * navigation is what keeps the two apart - the sweep's own hop passes
   * auto:true to put it back. */
  function goTo(url, auto) {
    stopCountdown();
    if (auto) markAuto(); else sessionStorage.removeItem(AUTO_KEY);
    if (url) location.href = url; else location.reload();
  }

  /* Fixed, not a setting: long enough that retrying does not extend the block,
   * short enough that a block which lifted at 3am does not cost the night. */
  const BLOCKED_WAIT_MINUTES = 3;

  /*
   * Hand the worker a retry N minutes out, and show the wait.
   *
   * For the states that must not poll at the normal interval but must not stop
   * either: a block that has to expire, a page the parser could not read. The
   * fallback deliberately does not depend on there being a panel to paint into
   * - the countdown line is a courtesy, the retry is the point.
   */
  async function retryIn(minutes, label) {
    markAuto();
    const armed = await send({ type: "armPoll", url: pollUrl(), minutes });
    const onAlarm = !!(armed && armed.ok);
    const el = shadow ? body().querySelector(".cd") : null;
    if (el) {
      countdown(el, Date.now() + minutes * 60000,
        (left) => { el.innerHTML = `<span class="hint">${label} ${clockText(left)}</span>`; },
        onAlarm ? null : () => goTo(pollUrl(), true));
    } else if (!onAlarm) {
      setTimeout(() => goTo(pollUrl(), true), minutes * 60000);
    }
  }

  /* ---------------------------------------------------------------- panel */

  function buildPanel() {
    if (panel) return;
    panel = document.createElement("div");
    panel.id = "rkt-root";
    shadow = panel.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="hd">
        <span class="dot"></span>
        <strong>RK-Termin Checker</strong>
        <button class="x" title="Hide">&times;</button>
      </div>
      <div class="body"></div>`;
    shadow.appendChild(card);
    card.querySelector(".x").addEventListener("click", () => panel.remove());
    document.documentElement.appendChild(panel);
  }

  const body = () => shadow.querySelector(".body");
  const setTone = (tone) => {
    shadow.querySelector(".card").className = "card " + tone;
  };

  /* ------------------------------------------------------------- captcha  */

  /* Struts dispatches on the submit button's NAME, and that name differs per
   * step (appointment_showMonth / _showDay / _addAppointment). Discard the
   * buttons that clearly do not advance and take the first of the rest, rather
   * than hardcoding one that only works on the month view. */
  function pickSubmit(form) {
    const skip = ["refreshcaptcha", "choose_category", "cancel", "abbrechen", "back", "zurueck"];
    const buttons = [...form.querySelectorAll('input[type="submit"], button[type="submit"]')];
    const usable = buttons.filter((b) => {
      const n = (b.name || "").toLowerCase();
      return n && !skip.some((s) => n.includes(s));
    });
    return usable.find((b) => b.name.includes("showMonth")) || usable[0] || null;
  }

  function submitCaptcha(form, text) {
    const input = form.querySelector('input[name="captchaText"]');
    if (!input) return false;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const button = pickSubmit(form);
    if (!button) return false;
    // Clicking the button (rather than form.submit()) is what makes Struts see
    // the action:* parameter it dispatches on.
    button.click();
    return true;
  }

  function renderCaptcha(result, wasWrong) {
    setTone(wasWrong ? "warn" : "");
    const form = P.findCaptchaForm(document);
    const img = result.captchaImage;

    body().innerHTML = `
      ${wasWrong ? '<div class="msg warn">That code was wrong — here is a fresh image.</div>' : ""}
      <div class="lbl">Type the code you see:</div>
      ${img ? `<img class="cap" src="${img}" alt="captcha">` : '<div class="msg">Captcha image not found on this page.</div>'}
      <input class="ans" type="text" autocomplete="off" spellcheck="false" placeholder="code">
      <div class="row">
        <button class="btn go">Check availability</button>
        <button class="btn ghost refresh">New image</button>
      </div>
      ${settings.twoCaptchaKey
        ? (autoFails() < autoFailLimit()
            ? '<div class="auto">Auto-solving via 2Captcha…</div>'
            : `<div class="auto">${autoFails()} wrong in a row — clearing the last 24 hours
               of cookies and trying again…</div>`)
        : ""}
      <div class="hint">Enter submits. The enlarged image above is the same one as on the page.</div>`;

    const answer = body().querySelector(".ans");
    answer.focus();

    const go = () => {
      const v = answer.value.trim();
      if (!v || !form) return;
      // Typed by hand: drop any id left over from an earlier auto-solve so a
      // rejection is not reported against a captcha 2Captcha never answered.
      sessionStorage.removeItem("rkt_captcha_id");
      // A gate page cannot know whether its own answer was right - the next
      // page says so. Mark the attempt and score it there.
      sessionStorage.setItem("rkt_pending", "manual");
      setAutoFails(0);
      body().innerHTML = '<div class="msg">Checking…</div>';
      submitCaptcha(form, v);
    };

    body().querySelector(".go").addEventListener("click", go);
    answer.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); go(); }
    });
    body().querySelector(".refresh").addEventListener("click", () => {
      const r = form && form.querySelector('input[name*="refreshCaptcha" i]');
      if (r) r.click(); else location.reload();
    });

    if (settings.twoCaptchaKey && img) {
      if (autoFails() < autoFailLimit()) detach(autoSolve(img, form));
      else detach(recoverSession());
    } else if (settings.twoCaptchaKey) {
      /* A key is set but no image could be read out of the page. There is
       * nothing to send the solver and nothing here changes on its own, so
       * without this the tab stops for good on a gate it cannot even attempt.
       * Same answer as any other failure: count it, and clear on the fourth. */
      setAutoFails(autoFails() + 1);
      if (autoFails() >= autoFailLimit()) detach(recoverSession());
      else retryLater();
    }
  }

  async function autoSolve(image, form) {
    const note = body().querySelector(".auto");
    const res = await send({ type: "solveCaptcha", image });
    if (!res || !res.ok) {
      const err = String((res && res.error) || "unknown");
      await bump("apiErrors");
      const note = body().querySelector(".auto");
      const say = (t) => { if (note) note.textContent = t; };

      /* A solver error counts exactly like a wrong answer: four in a row clear
       * the cookies and reload. Clearing cannot fix an empty balance or a
       * rejected key, but the error text is shown here and counted in the
       * popup, so the real problem is visible rather than guessed at. */
      setAutoFails(autoFails() + 1);
      if (autoFails() >= autoFailLimit()) {
        say(`2Captcha: ${err} — clearing the last 24 hours of cookies and retrying…`);
        return recoverSession();
      }
      say(`2Captcha: ${err} (${autoFails()}/${autoFailLimit()}) — fetching a fresh captcha…`);
      retryLater();
      return;
    }
    sessionStorage.setItem("rkt_captcha_id", res.id || "");
    sessionStorage.setItem("rkt_captcha_text", res.text || "");
    sessionStorage.setItem("rkt_pending", "2captcha");
    if (note) note.textContent = "2Captcha answered: " + res.text;
    if (form) submitCaptcha(form, res.text);
  }

  /* A beat before refetching, so a run of failures is readable rather than a
   * blur of reloads - and, more importantly, so a failure that returns instantly
   * (an empty balance answers in milliseconds) cannot turn into a reload loop
   * hammering the portal. It applies whether or not anyone is watching. */
  function retryLater() {
    /* "Automatic re-checking off" has to mean the page does not navigate itself
     * either, or a run of solver errors reloads the tab every few seconds under
     * someone who is sitting in front of it. Same reasoning as the cookie wipe. */
    if (!settings.autoReload) return;
    setTimeout(() => goTo(pollUrl(), true), 3000);
  }

  /*
   * Four wrong answers in a row: wipe the last 24 hours of cookies and carry on.
   *
   * No budget and no ceiling - it does this every time the counter reaches the
   * limit, for as long as the tab is open. The counter resets on any answer the
   * portal accepts.
   */
  async function recoverSession() {
    setAutoFails(0);
    const note = body().querySelector(".auto");

    /* Only while it is actually running unattended.
     *
     * The wipe reaches every site, not just this one. With automatic
     * re-checking switched off you are sitting at the keyboard, and signing you
     * out of other tabs mid-task - because a captcha the solver could not read
     * happened four times - is not something to do without being asked. The
     * button in Settings is still there for doing it deliberately. */
    if (!settings.autoReload) {
      if (note) {
        note.textContent = "Four wrong in a row. Automatic re-checking is off, so nothing was "
          + "cleared — type this one, or clear cookies yourself from Settings.";
      }
      return;
    }

    if (note) note.textContent = "Four wrong in a row — clearing the last 24 hours of cookies…";
    await send({ type: "clearSession" });
    goTo(pollUrl(), true);
  }

  /* -------------------------------------------------------------- results */

  /* Step from the month the page is actually showing, not from today. The
   * portal carries it both in the dateStr query parameter and in a hidden
   * field, and both survive the captcha round trip; today's date would make
   * "Next month" a no-op as soon as you are past the current month. */
  function currentMonth() {
    // The page's own MM/YYYY heading first: the captcha is submitted by POST,
    // so the resulting URL frequently has no dateStr to read.
    const shown = P.displayedMonth(document);
    if (shown) return shown;
    const fromUrl = new URLSearchParams(location.search).get("dateStr") || "";
    const hidden = document.querySelector('input[name="dateStr"], input[name="date"]');
    const parsed = P.parseDate(fromUrl) || P.parseDate(hidden ? hidden.value : "");
    return parsed ? parsed.text : "";
  }

  /* Re-request the current month by GET.
   *
   * The month page is the response to a POSTed captcha form, so location.reload()
   * there asks Chrome to re-submit it and raises a "Confirm Form Resubmission"
   * interstitial instead of fetching the page - which would stall the polling
   * loop on the one page it runs on most. A GET to the same month sidesteps it
   * and lands on a fresh gate, which is the cycle we want anyway. */
  function pollUrl() {
    return monthUrl(0);
  }

  function monthUrl(offset) {
    // Follow the portal's own arrow when it is on the page; only rebuild the
    // URL when it is not (for instance from the captcha gate).
    const own = P.monthNavHref(document, offset);
    if (own) return new URL(own, "https://service2.diplo.de/rktermin/").href;

    // Identify the category from the page itself, falling back to settings only
    // when the page carries nothing. Otherwise re-checking a page whose
    // category differs from your saved settings navigates you somewhere else.
    const ctx = P.pageContext(document);
    const dateStr = P.stepMonth(currentMonth(), offset);
    return `${HOST}?locationCode=${encodeURIComponent(ctx.locationCode || DEFAULT_PORTAL.locationCode)}`
      + `&realmId=${encodeURIComponent(ctx.realmId || DEFAULT_PORTAL.realmId)}`
      + `&categoryId=${encodeURIComponent(ctx.categoryId || DEFAULT_PORTAL.categoryId)}`
      + `&dateStr=${dateStr}`;
  }

  function renderDates(result, isNewFind) {
    /* Always at least one: classify() only returns DATES when it found a date,
     * and with the date window gone there is nothing left to filter them by. */
    const shown = result.dates;

    setTone("good");
    // Alert on a *change* in what is open. Re-announcing the same slot on every
    // poll is how an alert becomes background noise.
    if (isNewFind) send({ type: "found", dates: shown });
    else send({ type: "status", state: "dates", dates: shown });
    clearSweep();   // stay on the month that has them

    body().innerHTML = `
      <div class="big">${shown.length} date${shown.length > 1 ? "s" : ""} available</div>
      <ul class="dates">
        ${shown.map((d) => `<li><a href="${d.href ? new URL(d.href, "https://service2.diplo.de/rktermin/").href : "#"}">${d.text}</a></li>`).join("")}
      </ul>
      <div class="row">
        <button class="btn ghost next">Next month</button>
        <button class="btn ghost again">Re-check</button>
      </div>
      <div class="row"><button class="btn ghost pause">Pause watching</button></div>
      <div class="cd"></div>
      <div class="dbg"></div>`;

    body().querySelector(".next").addEventListener("click", () => goTo(monthUrl(1)));
    body().querySelector(".again").addEventListener("click", () => goTo(pollUrl()));

    // Clicking through to a date means booking has started - stop reloading
    // out from under the form.
    body().querySelectorAll(".dates a").forEach((a) => {
      a.addEventListener("click", () => {
        stopCountdown();
        paused = true;
        detach(send({ type: "disarmPoll" }));
      });
    });

    const pauseBtn = body().querySelector(".pause");
    pauseBtn.addEventListener("click", () => {
      paused = !paused;
      pauseBtn.textContent = paused ? "Resume watching" : "Pause watching";
      if (paused) {
        stopCountdown();
        detach(send({ type: "disarmPoll" }));
        body().querySelector(".cd").innerHTML = '<span class="hint">Paused — book without interruption.</span>';
      } else {
        detach(startCountdown({ watching: true }));
      }
    });

    // Keep polling: a slot that is open now can be taken before you finish the
    // form, so the search continues until you pause it or click a date.
    if (settings.autoReload && !paused) {
      showSweepState("openings here — staying put");
      detach(startCountdown({ watching: true }));
    }
  }

  function renderEmpty() {
    setTone("");
    send({ type: "status", state: "empty", dates: [] });
    body().innerHTML = `
      <div class="big dim">No appointments</div>
      <div class="hint">Nothing open for this month and category.</div>
      <div class="row">
        <button class="btn ghost next">Next month</button>
        <button class="btn ghost again">Re-check now</button>
      </div>
      <div class="cd"></div>
      <div class="dbg"></div>`;
    body().querySelector(".next").addEventListener("click", () => goTo(monthUrl(1)));
    body().querySelector(".again").addEventListener("click", () => goTo(pollUrl()));
    if (settings.autoReload) {
      if (advanceSweep()) return;
      detach(startCountdown());
    } else {
      showSweepState("no walk: auto-reload off");
    }
  }

  /* ---------------------------------------------------------- month sweep */

  /*
   * One captcha, both months.
   *
   * The gate is served when the session expires, not on every page load, so a
   * month navigated to straight after solving one rides the same session and
   * costs nothing extra. The expiry also decides where you land - whichever
   * month the session died on - so a poll that only ever re-read that page
   * would leave the other month unwatched for as long as the tab ran.
   *
   * So each cycle walks the pair: check where we landed, step to the sibling,
   * and only then start the countdown. Two page loads, one captcha.
   *
   * Openings stop the walk. Navigating away from a month that has slots on it
   * to go and look at the other one is how you lose the slot.
   */
  const SWEEP_KEY = "rkt_sweep";
  const SWEEP_STALE_MS = 10 * 60 * 1000;

  /* Everything the sweep decided, in one readable line. Without it a cycle that
   * misbehaves is invisible: you see two months and a wait, and cannot tell
   * whether the walk ran, was skipped, or never applied to these months. */
  function showSweepState(note) {
    if (!shadow) return;
    const el = body().querySelector(".dbg");
    if (!el) return;
    const here = P.monthKey(P.displayedMonth(document));
    const pair = P.sweepPair();
    const visited = readSweep();
    el.innerHTML = `<span class="hint">on ${here || "?"} · pair ${pair.join("+")}`
      + ` · ${wasAutoLoad ? "auto" : "manual"} load`
      + ` · seen ${visited.length ? visited.join(",") : "none"}`
      + ` · ${note}</span>`;
  }

  function readSweep() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SWEEP_KEY) || "null");
      // A cycle interrupted by a long captcha stall should not resume into a
      // half-finished walk hours later; treat an old one as a fresh start.
      if (!s || !Array.isArray(s.months)) return [];
      if (Date.now() - (s.at || 0) > SWEEP_STALE_MS) return [];
      return s.months;
    } catch (_) { return []; }
  }

  const clearSweep = () => sessionStorage.removeItem(SWEEP_KEY);

  /*
   * Returns true when it has navigated, meaning the caller must not start a
   * countdown: this cycle is not over yet.
   */
  function advanceSweep() {
    if (paused) { showSweepState("no walk: paused"); return false; }
    if (!settings.autoReload) { showSweepState("no walk: auto-reload off"); return false; }
    if (!wasAutoLoad) { showSweepState("no walk: you opened this page"); return false; }

    const here = P.monthKey(P.displayedMonth(document));
    const pair = P.sweepPair();
    // A month outside the pair means you navigated somewhere deliberately.
    // Walking you back to this month would fight you for control of the tab.
    if (!here || pair.indexOf(here) === -1) {
      clearSweep();
      showSweepState(here ? `no walk: ${here} is outside the pair` : "no walk: month unreadable");
      return false;
    }

    const visited = readSweep();
    if (visited.indexOf(here) === -1) visited.push(here);

    const target = P.sweepNext(here, visited, pair);
    if (!target) { clearSweep(); showSweepState("walk done: both months seen"); return false; }

    sessionStorage.setItem(SWEEP_KEY, JSON.stringify({ at: Date.now(), months: visited }));
    showSweepState(`walking on to ${target}`);

    // Offset is measured from the month on screen, so the portal's own arrow
    // is the right link to follow and keeps its parameters intact.
    const offset = pair.indexOf(target) - pair.indexOf(here);
    const url = monthUrl(offset);

    /* A short beat before moving on, so the month you just checked is actually
     * readable rather than flashing past. It is for your eyes only: a hidden
     * tab has nobody watching, and a throttled setTimeout would stretch five
     * seconds into a minute, so hop immediately when nothing is looking. */
    const wait = document.visibilityState === "visible"
      ? Math.max(0, Number(settings.sweepPauseSeconds) || 0) * 1000
      : 0;

    if (!wait) { goTo(url, true); return true; }

    const el = body().querySelector(".cd");
    // No line to paint into means there is nothing to wait for - the beat is
    // for your eyes only - so walk on rather than stalling the cycle on it.
    if (!el) { goTo(url, true); return true; }

    countdown(el, Date.now() + wait,
      (left) => {
        el.innerHTML = `<span class="hint">Nothing here — checking ${target} in ${left}s…</span>`;
      },
      () => goTo(url, true));
    return true;
  }

  /* The gate is served when the session expires rather than on every load, and
   * at a poll interval of a minute or more the session has usually gone by the
   * time the next one fires - so unattended running still needs a 2Captcha key.
   * Without one the reload parks you on a fresh gate with the field focused, so
   * the countdown is shown either way, with the caveat spelled out.
   *
   * The interval is adaptive rather than fixed: repeated empties stretch it out
   * and off-hours suspend it entirely. Request volume is what the portal
   * actually limits, so keeping volume low is what keeps you unblocked. */
  async function startCountdown(opts) {
    opts = opts || {};
    const el = body().querySelector(".cd");
    if (!el) return;
    if (paused) return;

    // One fixed interval, around the clock. Missions do release slots
    // overnight, so there is no window worth skipping.
    const waitMinutes = Math.max(1, Number(settings.intervalMinutes) || 2);

    /* Hand the schedule to the service worker. The marker goes on now, because
     * the alarm navigates this tab without running goTo. */
    markAuto();
    const armed = await send({ type: "armPoll", url: pollUrl(), minutes: waitMinutes });
    const onAlarm = !!(armed && armed.ok);

    /* Read the clock rather than counting ticks. A throttled tab redraws this
     * line late, but each redraw still shows the true time remaining instead of
     * however many ticks happened to have been delivered. */
    const reason = opts.watching ? "Still watching — re-checking in" : "Re-checking in";

    countdown(el, Date.now() + waitMinutes * 60000,
      (left) => {
        el.innerHTML = `<span class="hint">${reason} ${clockText(left)}`
          + `${settings.twoCaptchaKey ? "" : " — you'll need to type the captcha"}</span>`;
      },
      // With the alarm armed the worker navigates and this line is only a
      // display. Without it - no worker, no permission - the page falls back to
      // driving the poll itself, throttling and all.
      onAlarm ? null : () => detach(bump("autoPolls").then(() => goTo(pollUrl(), true))));
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  /*
   * The booking form. It carries a captcha like the month gate does, but its
   * submit button is action:appointment_addAppointment - pressing it books the
   * appointment. So this panel enlarges the image and can type the code into
   * the page's field, and stops there: no auto-solve, no auto-submit, no
   * polling. Submitting is yours.
   */
  function renderBooking(result) {
    setTone(result.captchaWrong ? "warn" : "");
    stopCountdown();
    const img = result.captchaImage;
    body().innerHTML = `
      <div class="big">Booking form</div>
      ${result.captchaWrong ? '<div class="msg warn">That code was wrong — a fresh image is on the page.</div>' : ""}
      <div class="hint" style="margin-top:0">Watching is paused. Fill in your details and submit the
      form yourself — this panel will not submit it for you.</div>
      ${img ? `<img class="cap" src="${img}" alt="captcha">` : ""}
      ${img ? `<input class="ans" type="text" autocomplete="off" spellcheck="false" placeholder="code">
      <div class="row"><button class="btn ghost fill">Copy code into the form</button></div>` : ""}`;

    const answer = body().querySelector(".ans");
    if (!answer) return;
    const fill = () => {
      const field = document.querySelector('input[name="captchaText"]');
      if (!field) return;
      field.value = answer.value.trim();
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
    };
    body().querySelector(".fill").addEventListener("click", fill);
    answer.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fill(); } });
  }

  /* The day view: time slots for a date already chosen. Booking is under way,
   * so polling stays off - reloading here would throw away the slot. */
  function renderDay() {
    setTone("");
    stopCountdown();
    body().innerHTML = `
      <div class="big">Choosing a time</div>
      <div class="hint" style="margin-top:0">Watching is paused so it cannot reload while you book.
      Pick a time slot to continue.</div>
      <div class="row"><button class="btn ghost back">Back to watching</button></div>`;
    body().querySelector(".back").addEventListener("click", () => goTo(pollUrl()));
  }

  /* The one state where continuing to poll is actively counterproductive:
   * more requests while blocked extend the block. */
  function renderBlocked() {
    setTone("warn");
    stopCountdown();
    send({ type: "status", state: "blocked", dates: [] });
    body().innerHTML = `
      <div class="big">Request limit hit</div>
      <div class="hint">The portal is refusing requests from this connection. Polling at the normal
      interval has stopped — more requests now would only extend the block — but the watch does not
      end here: it backs off and comes back on its own.</div>
      <div class="row"><button class="btn ghost again">Re-check now</button></div>
      <div class="cd"></div>`;
    body().querySelector(".again").addEventListener("click", () => goTo(pollUrl()));
    /* Long enough to be worth calling a back-off rather than a poll. Stopping
     * outright was the old behaviour and it is indistinguishable, from across
     * the room at 4am, from the extension having crashed. */
    if (settings.autoReload) detach(retryIn(BLOCKED_WAIT_MINUTES, "Blocked — trying again in"));
  }

  /* ----------------------------------------------------------------- main */

  async function main() {
    /* Exactly one poll alarm exists at a time, and every page load cancels it.
     * Only a page that means to keep watching arms a new one, so a booking
     * form, a day view, a block page or a page we cannot read simply never does
     * - and the worker can never navigate a tab that is mid-booking.
     *
     * This is deliberately the first thing that happens, ahead of even reading
     * the settings. It does not depend on them, and a settings read that failed
     * used to return from here with the worker's watchdog still armed - the one
     * path by which a poll could have fired under a booking form.
     *
     * If the extension itself is unreachable both messages fail and the alarm
     * outlives this page. That case self-heals rather than misfiring: the tab
     * gets navigated once more, and the fresh load runs a content script that
     * disarms normally. */
    await send({ type: "disarmPoll" });

    const res = await send({ type: "getSettings" });
    if (!res || !res.ok) return;
    settings = res.settings;

    /* Learn the category from the page instead of being told it.
     *
     * Every stage carries locationCode / realmId / categoryId somewhere - the
     * gate and booking form in hidden inputs, the month and day views in their
     * links - so whichever appointment page you open identifies itself. Saving
     * it is what lets the popup's "Open appointment page" button and the
     * notification click go to the right place without anyone copying three
     * values out of a URL. It follows you: open a different category and the
     * next load records that one. */
    const ctx = P.pageContext(document);
    if (ctx.locationCode && ctx.realmId && ctx.categoryId) {
      const { portal } = await chrome.storage.local.get("portal");
      if (!portal || portal.locationCode !== ctx.locationCode
          || portal.realmId !== ctx.realmId || portal.categoryId !== ctx.categoryId) {
        await chrome.storage.local.set({ portal: ctx });
      }
    }

    const result = P.analyse(document);

    // Read the marker before anything can navigate, and clear it only once a
    // month page is actually reached - the gate in between must not eat it.
    wasAutoLoad = sessionStorage.getItem(AUTO_KEY) === "1";
    if (P.spendsAutoMarker(result.state)) sessionStorage.removeItem(AUTO_KEY);

    if (result.state === P.STATE.UNKNOWN) {
      /* Not a page we understand: a session-expiry notice, a maintenance page,
       * an error. This is where an unattended run used to die silently - the
       * alarm was cancelled at the top of this function and nothing here armed
       * another, so the tab sat on it indefinitely.
       *
       * If the timer is what brought us here, treat it as a failed poll and go
       * round again. If you navigated here yourself, stay out of the way as
       * before rather than dragging the tab off a page you chose.
       *
       * The status goes out either way: without it the popup keeps showing
       * whatever it last saw - "No appointments" from hours ago - while the tab
       * sits on a page it cannot read, which is exactly when you need it to be
       * honest. */
      send({ type: "status", state: "unknown", dates: [] });

      if (settings.autoReload && wasAutoLoad) {
        buildPanel();
        body().innerHTML = `
          <div class="big dim">Page not recognised</div>
          <div class="hint">Not a page the checker can read. Re-checking, so a stray error or
          session-expiry page cannot quietly end the watch.</div>
          <div class="cd"></div>`;
        detach(retryIn(Math.max(1, Number(settings.intervalMinutes) || 2), "Re-checking in"));
      }
      return;
    }

    buildPanel();

    // A solve is scored by the page that follows it: the gate re-rendered with
    // an error means it was wrong, any other outcome means it got through.
    const pending = sessionStorage.getItem("rkt_pending");
    if (pending) {
      const who = pending === "2captcha" ? "auto" : "manual";
      if (result.state === P.STATE.CAPTCHA_ERROR) {
        await bump(who + "Failed");
        // This is the counter that reaches four and triggers the wipe.
        if (who === "auto") setAutoFails(autoFails() + 1);
      } else if (result.state === P.STATE.DATES || result.state === P.STATE.EMPTY) {
        await bump(who + "Solved");
        // Auto-solving is working again, so the run of failures goes back to
        // zero and the next wipe is four fresh failures away.
        if (who === "auto") {
          setAutoFails(0);
          // This answer got through, so its shape is worth telling the solver
          // about next time - length and whether it was all digits.
          const text = sessionStorage.getItem("rkt_captcha_text");
          if (text) send({ type: "learnCaptcha", text });
        }
      }
      if (result.state !== P.STATE.CAPTCHA) {
        sessionStorage.removeItem("rkt_pending");
        sessionStorage.removeItem("rkt_captcha_text");
      }
    }

    switch (result.state) {
      case P.STATE.CAPTCHA_ERROR: {
        const id = sessionStorage.getItem("rkt_captcha_id");
        if (id) { send({ type: "reportBadCaptcha", id }); sessionStorage.removeItem("rkt_captcha_id"); }
        renderCaptcha(result, true);
        break;
      }
      case P.STATE.CAPTCHA:
        send({ type: "status", state: "captcha" });
        renderCaptcha(result, false);
        break;
      case P.STATE.DATES: {
        sessionStorage.removeItem("rkt_captcha_id");
        // Count a find once per distinct set of openings, so re-loading a
        // result page does not inflate the tally.
        const key = P.datesKey(result.dates);
        const { lastFoundKey } = await chrome.storage.local.get("lastFoundKey");
        const isNewFind = !!key && key !== lastFoundKey;
        if (isNewFind) {
          await bump("appointmentsFound");
          await chrome.storage.local.set({ lastFoundKey: key });
        }
        renderDates(result, isNewFind);
        break;
      }
      case P.STATE.EMPTY:
        sessionStorage.removeItem("rkt_captcha_id");
        await chrome.storage.local.set({ lastFoundKey: "" });
        renderEmpty();
        break;
      case P.STATE.BOOKING:
        send({ type: "status", state: "booking" });
        renderBooking(result);
        break;
      case P.STATE.DAY:
        send({ type: "status", state: "day" });
        renderDay();
        break;
      case P.STATE.BLOCKED: {
        // One block is one event, however many times you retry into it. Without
        // this guard a single ten-minute block reads as a dozen separate ones.
        const { lastBlockAt = 0 } = await chrome.storage.local.get("lastBlockAt");
        if (Date.now() - lastBlockAt > 10 * 60 * 1000) {
          await bump("blocked");
          await chrome.storage.local.set({ lastBlockAt: Date.now() });
        }
        renderBlocked();
        break;
      }
    }
  }

  const PANEL_CSS = `
    :host { all: initial; }
    .card {
      position: fixed; top: 16px; right: 16px; width: 320px; z-index: 2147483647;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #fff; color: #202124; border: 1px solid #dadce0; border-radius: 12px;
      box-shadow: 0 6px 28px rgba(0,0,0,.18); overflow: hidden;
    }
    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
          background: #f1f3f4; border-bottom: 1px solid #e0e0e0; }
    .hd strong { flex: 1; font-size: 13px; font-weight: 600; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; }
    .card.good .dot { background: #137333; } .card.warn .dot { background: #d93025; }
    .card.good .hd { background: #e6f4ea; } .card.warn .hd { background: #fce8e6; }
    .x { border: 0; background: none; font-size: 18px; line-height: 1; cursor: pointer; color: #5f6368; padding: 0 2px; }
    .body { padding: 12px; }
    .lbl { font-weight: 600; margin-bottom: 8px; }
    .cap { display: block; width: 100%; image-rendering: -webkit-optimize-contrast;
           border: 1px solid #dadce0; border-radius: 6px; background: #fff; margin-bottom: 10px; }
    .ans { width: 100%; box-sizing: border-box; padding: 9px 10px; font-size: 17px;
           letter-spacing: 2px; text-align: center; border: 2px solid #1a73e8; border-radius: 6px; }
    .row { display: flex; gap: 8px; margin-top: 10px; }
    .btn { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid #1a73e8;
           background: #1a73e8; color: #fff; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn.ghost { background: #fff; color: #1a73e8; }
    .big { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
    .big.dim { color: #5f6368; font-weight: 600; }
    .dates { list-style: none; margin: 0 0 6px; padding: 0; max-height: 190px; overflow: auto; }
    .dates li { padding: 6px 8px; border-radius: 6px; background: #e6f4ea; margin-bottom: 4px; font-weight: 600; }
    .dates li.dim { background: #f1f3f4; color: #80868b; font-weight: 400; }
    .dates a { color: #0b6b33; text-decoration: none; }
    .dates a:hover { text-decoration: underline; }
    .hint { font-size: 11px; color: #5f6368; margin-top: 8px; }
    .msg { padding: 8px; border-radius: 6px; background: #f1f3f4; margin-bottom: 8px; }
    .msg.warn { background: #fce8e6; color: #c5221f; }
    .auto { font-size: 11px; color: #1a73e8; margin-top: 8px; }
    .dbg { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #dadce0; opacity: .75; }
    .dbg .hint { font-size: 10px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #202124; color: #e8eaed; border-color: #3c4043; }
      .hd { background: #292a2d; border-color: #3c4043; }
      .card.good .hd { background: #1e3a29; } .card.warn .hd { background: #3d2220; }
      .ans { background: #202124; color: #e8eaed; }
      .btn.ghost { background: #202124; }
      .msg, .dates li.dim { background: #292a2d; }
      .dates li { background: #1e3a29; } .dates a { color: #81c995; }
    }`;

  detach(main());
})();
