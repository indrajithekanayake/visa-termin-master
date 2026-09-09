# RK-Termin Appointment Checker

Chrome extension that watches the German mission appointment portal
(`service2.diplo.de/rktermin`) and tells you the moment a date opens up.

It replaces the tedious part of checking: squinting at a 350×50 captcha, then
scanning the result page to work out whether anything is actually free.

## Install

```
git clone <this repo>          # or just use the folder as-is
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `termin-checker` folder
4. Open the appointment page you normally use

**Nothing to configure to start.** Location, realm and category are read from
whichever appointment page you open — every stage of the portal carries them,
in hidden inputs on the gate and booking form and in the links on the month and
day views. Open a different category and the next page load records that one, so
the popup's *Open appointment page* button and the notification click follow you
around instead of pointing at whatever was typed in once.

The only setting worth visiting on day one is the **2Captcha API key**, and only
if you want it to run while you are away.

## Use

Open the appointment page (or click **Open appointment page** in the popup). A
panel appears top-right:

- **On the captcha gate** — the image is shown enlarged with the input focused.
  Type the code, press Enter.
- **When dates are open** — they are listed and linked, you get a desktop
  notification, a phone alert if you set one up, and the toolbar badge turns green.
- **When nothing is open** — it says so, with one click to step to the next
  month or re-check.

Every open date is reported. There is no window to configure.

## Automatic re-checking

Optional, off by default. When on, the page reloads on your chosen interval
while the tab stays open.

The catch: **the captcha comes back whenever the session has expired**, which at
a poll interval of a minute or more is very nearly every poll. Unattended polling
only gets past that if you set a 2Captcha API key in Settings (the same service
the [python version](https://github.com/indrajithekanayake/visa-termin-master)
uses). Without a key the timer still helps — it parks you on a fresh gate with
the field focused — but you type each one.

Pages loaded *immediately* after one is solved ride the same session and are
free, which is what makes the two-month sweep below cost nothing extra.

When you are actually at the machine, typing it yourself is both faster and more
accurate. The solver misreads this particular font often enough to matter, and
the extension has to detect the rejection and retry, so the round trip is
frequently slower than four keystrokes.

### Polling behaviour

Defaults are tuned to find an opening as early as possible:

| Setting | Default | Why |
|---|---|---|
| Interval | **2 minutes, fixed** | No backoff — a stretched interval delays the find. Two is the floor: this host has obvious anti-bot control. |
| Active hours | **around the clock** | Missions do release batches overnight, so there is no window worth skipping and none to configure. |
| After a find | **keeps watching** | An open slot is not a booked slot; someone else can take it while you fill the form. |

It keeps polling after finding something, and stops only when you actually
start booking — clicking a date link pauses it automatically, and there is a
**Pause watching** button for when you want to fill the form undisturbed.

Alerts fire on a *change* in what is open, not on every poll. If the same slot
stays available you get one notification that stays on screen, rather than a
alert on every poll training you to ignore it.

**If you get rate-limited, you will know.** A block page is detected as its own
state rather than being misread as "no appointments": polling at the normal
interval stops, the badge turns red, and the popup counts it under *Times
rate-limited*. Continuing to poll while blocked only extends the block.

It does not stop for good, though. After three minutes it tries again on its own. A block that expired at 3am should not cost you the rest
of the night, and a tab parked on a block page until someone clicks it is
indistinguishable, from across the room, from one that has crashed.

If that counter starts climbing, raise the interval in Settings — that is the
only dial, and it is the one that matters.

## Hands-off captcha solving

Set a **2Captcha API key** in Settings and the loop runs unattended: the
extension reads the captcha image, sends it to 2Captcha, types the answer into
the field and submits it — including the automatic retry when an answer comes
back wrong. Without a key, the panel shows the image enlarged with the field
focused and you type it.

It is a paid service, around $1 per 1000 captchas — a day of 2-minute polling is
a few cents. Wrong answers are reported back for a refund automatically.

**None of this is a session problem.** With no cookie, every poll to a clean URL
is already a fresh session, so there is no souring to recover from. What is left
is the picture itself.

**Expect around 60%, and know why.** Measured from the live gate, the image is
a **300×50 JPEG holding six to eight variable-length alphanumeric characters** —
about forty pixels a character. That is at the hard end of what a human solver
reads accurately, and it, rather than anything about sessions, is what sets the
error rate. Accuracy is also what governs throughput, not the poll interval: a
wrong answer costs a whole extra gate, solve and page load.

**It learns what these captchas look like.** The solver used to be told
`numeric: 0, min_len: 1` — "anything, at least one character" — which is the
least useful thing you can tell someone reading a distorted image. Every answer
the portal *accepts* now teaches it the length and whether it was all digits,
and after eight samples that goes out with each request, along with a plain
instruction to the worker ("Enter the 6-8 letters and digits shown").

The hint only ever asserts what accepted answers have actually shown — a longer
one widens the range rather than being discarded — and it says nothing until
there is enough evidence. The popup shows what it settled on under *Captcha
shape learned*; resetting the counters forgets it, which is the way back if a
hint ever looks wrong.

**`autoFailLimit` is the throughput setting that matters.** At a ~40% error rate
three misses in a row happen by chance roughly every fifteen attempts, so a
limit of 3 fires the recovery ladder on noise and throws away sessions that were
working — and a live session is what lets a poll through *without* a gate. The
default is 6, where the same run of luck is 0.5% while a genuinely dead session
still trips it within a few attempts.

**A run of failures slows down; it never stops.** A wrong answer re-renders the
gate, which would trigger another solve — with a bad key, a degraded service or
a font the solver cannot read, that is an unbounded loop of paid calls at full
speed. So failures are counted, and hitting the limit puts the loop through
clearing the session and then waiting, rather than through more of the same.
What it does not do is come to rest waiting for you to type one. See
[Staying unblocked](#staying-unblocked).

**It never runs on the booking form.** That page carries a captcha too, but its
submit button is `action:appointment_addAppointment` — pressing it books the
appointment. Auto-solving there would submit your application with empty
personal details.

## What drives the polling

The schedule lives in the service worker as a `chrome.alarms` alarm, not as a
timer in the page.

That is not an implementation detail. Chrome throttles page timers in hidden
tabs to **one tick a minute** once a tab has been hidden for five, and the old
countdown spent one tick per second of waiting — so a one-minute interval
quietly became a one-hour one the moment you switched tabs. The whole point of
this thing is running while you are not watching it.

The worker has no visibility state for Chrome to throttle on, so the schedule
holds whether the tab is in front or buried. The worker also performs the
navigation itself, which keeps working when the content script is not running at
all: a tab discarded by Memory Saver is simply pointed at the URL again and
loads fresh.

The countdown in the panel is now only a display. It reads the clock rather than
counting ticks, so a throttled tab redraws that line late but still shows the
true time remaining — and the poll underneath it fires on time regardless.

**Exactly one alarm exists at a time, and every page load cancels it.** Only a
page that means to keep watching arms a new one, which is what makes it safe: a
booking form, a day view, a block page or a page the parser cannot read never
arms anything, so the worker can never navigate a tab that is mid-booking.
Pausing, and clicking through to a date, both cancel it outright. A month gate
arms one only when auto-solving is waiting out a run of failures — the booking
form's gate, which is a different state, never does.

If the worker cannot be reached the page falls back to driving the poll itself,
throttling and all — degraded, but not stopped.

**And the worker covers the page in turn.** `armPoll` is only ever called by the
content script, so a navigation that never runs one — a Chrome network-error
page after a wifi blip, a portal 502, a tab discarded mid-load — would end the
watch with nothing scheduled and nobody to notice. So the worker re-arms itself
for three minutes the moment it navigates. Any page that *does* run the content
script cancels that a second later, because `main()` disarms unconditionally
before it even reads the settings. What survives is exactly the case it exists
for: nothing ran.

**It is flat: three minutes, always.** No escalation and no dial — a block
delivered as a dropped connection never renders the page that would back off on
its own, so the worker retries at the same steady rate until something answers.

**Those retries are not counted as polls.** *Auto-refreshes* and the rate beside
*Running for* are meant to answer "is checking actually happening", and counting
attempts into a dead network would make an outage read as a healthy run.

That unconditional disarm is also why the watchdog cannot fire under a booking —
the booking form runs the content script like any other page, and disarming is
the first thing it does, ahead of anything that could fail and return early. If
the extension itself is unreachable both messages fail and the alarm outlives
the page; that case self-heals rather than misfiring, since the tab is navigated
once more and the fresh load disarms normally.

## Both months, one captcha

The portal offers a short booking horizon — in practice the current month and
the next — and the captcha drops you on whichever of the two the session expired
on, not on one you chose. A poll that only re-read the page it landed on would
leave the other month unwatched for as long as the tab ran.

So each cycle walks the pair: check where it landed, step to the sibling, and
only then start the countdown. Land on August and it checks September; land on
September and it steps back to August.

**This costs no extra captchas.** The gate guards session expiry, not page
loads, so the sibling — fetched a second or so after the first page — rides the
session already paid for. Two page loads, one captcha. Your 2Captcha balance
lasts exactly as long as it did before.

**It does double your requests to the portal**, though: two loads per cycle
rather than one, so 2880 a day at a 1-minute interval instead of 1440. Captchas
are what you pay for, but requests-per-IP is what gets you blocked, so this is
the trade the sweep actually makes. Watch *Times rate-limited* in the popup — if
it starts climbing, raise the interval.

The pair is recomputed from the clock on every poll rather than stored. A tab
left open across a month boundary moves its window forward on its own, instead
of sweeping a month that is now in the past.

**Openings stop the walk.** If the month you land on has slots, the sweep is
abandoned and you stay on that page — navigating away to look at the other month
is how you lose the slot. The alert has already fired by then.

**It only ever walks on a load the timer started.** Your own clicks are left
alone: press *Next month* and you get the next month and stay there, press
*Re-check now* and you re-check the month you are on. Otherwise the sweep would
bounce you off the two months you are most likely to be looking at.

## Getting told on your phone

The desktop notification only helps when you are at the desk, which is the one
situation where unattended polling was not needed. Set an **ntfy topic** in
Settings and a find also pushes to your phone.

[ntfy](https://ntfy.sh) is free and open source, with apps on iOS and Android.
Subscribe to a topic name in the app, put the same name in Settings, and press
**Send test alert** to confirm it arrives before you rely on it. Alerts go out at
priority 5 — the long alarm-style alert rather than a quiet blip — and tapping
one opens the month page.

**Choose a long, unguessable topic name.** On the public ntfy.sh server a topic
is nothing but a URL: no account, no password. Anyone who guesses the name reads
your alerts and can push fake ones at you. Something like
`rktermin-colo-7f3a91c4`, not `visa`. The messages say only which dates are open,
but there is no reason to leave it guessable.

**The alert repeats while the slot stays open** — once a minute, up to 12 times,
then it stops. A slot found at 04:00 is worth nothing if one push slides past you
while you sleep, and unlike a desktop chime this one is not training you to
ignore it: it stops the moment the openings change or run out, and it stops
anyway after twelve. Not configurable.

For the repeat to be able to wake you, allow ntfy through Do Not Disturb in your
phone's settings — no notification priority overrides that from the server side.

It does not book for you, and neither does tapping the alert. The captcha and
the session are bound to the tab on your machine, so the alert's job is to get
you back to the keyboard, not to move the booking to the phone.

## Staying unblocked

**Four wrong captchas in a row clears the last 24 hours of browser cookies**,
then checking carries on. That is the whole recovery mechanism.

**Every site is in range, but only cookies created in that window.** The scope
is time, not site. Re-issuing a cookie with the same name, domain and path
preserves its original creation date (RFC 6265 5.3.11.3), so a login from last
week that is refreshed on every request still reads as last week and is not
touched. What goes is what was first set inside the window: today's sign-ins,
today's session cookies, and the portal's own. A real cost, but a smaller one
than "all your cookies" — and chosen after every narrower form was tried on the
live portal: removal by cookie name, by path, by domain, by store, and scoped to
the portal's own origin all removed exactly nothing. `chrome.cookies` reports no
cookies for `service2.diplo.de` even with host access granted, the tab visible
to the service worker, and the page itself holding a `JSESSIONID`. Unexplained,
and no longer chased — the blanket wipe is the one thing that reaches them.

**There is no budget and no ceiling.** It clears every time the count reaches
four, for as long as the tab is open. Any answer the portal accepts resets the
count to zero.

**2Captcha errors never trigger it.** An empty balance, a rejected key, an
unreadable image — none of those are fixed by clearing cookies, and signing you
out of everything in response to a 2Captcha outage would be pure damage. They
count towards the same four, so a run of them clears too — but each attempt is
held back three seconds first, which is what stops an error that answers
instantly (an empty balance does) from becoming a reload loop against the
portal. The error text is shown in the panel and counted in the popup, so a bad
key is visible rather than guessed at.

There is also a **Clear cookies from the last 24 hours now** button in Settings
for doing it by hand.

**It only fires while running unattended.** With automatic re-checking switched
off you are at the keyboard, and signing you out of other tabs mid-task because
a captcha failed four times is not something to do unasked — the panel says so
and leaves the button to you.

## Statistics

The toolbar popup tracks, since the last reset:

- **Auto-refreshes** — polls fired by the timer. Manual reloads and your own
  "Re-check" clicks are deliberately not counted, so the number reflects
  unattended work.
- **Running for** — measured from the first unattended poll, not from the last
  reset, since counters can sit idle for days before watching starts. Ticks live
  while the popup is open, and shows the observed polls-per-minute.
- **Solved by 2Captcha** / **2Captcha got it wrong** / **Typed by hand**, plus
  the solver's accuracy rate. A gate page cannot know whether its own answer was
  right, so each attempt is scored by the page that follows it: the gate
  re-rendered with an error counts as failed, anything else counts as solved.
  The attempt is attributed to whoever produced it.
- **Appointments found** — counted once per *distinct set* of openings, so the
  same slot seen on twenty consecutive polls is one find, not twenty.
- **Times rate-limited** — how often the portal refused the connection. This is
  the number that tells you whether your polling rate is actually a problem.

## What it does not do

**It does not book.** It reads the month view and reports what is free — the
booking form, personal details and confirmation are left to you. Checking is the
tedious part; taking the slot is the part worth doing by hand, and an
auto-booker racing other applicants is a different tool with different effects.

## How it works

Everything runs in a content script, inside the real page. That is deliberate:
the portal keeps its session in a `;jsessionid` path parameter on the form
action, and the captcha is bound to that session. Reading the image in one
context and posting the answer from another lands in a different session and can
never validate. Running in-page means the browser handles the session and no
cookie juggling is needed.

| File | Role |
|---|---|
| `parser.js` | Page classification and date extraction. No DOM globals, so it is testable. |
| `content.js` | Panel UI, captcha fill/submit, re-check timer. |
| `background.js` | Notifications, badge, 2Captcha relay (kept out of the page so the key is not exposed). |
| `options.js` / `popup.js` | Settings and status. |

### Page states

`parser.js` sorts every page into one of five states. Order matters: a wrong
captcha re-renders the *gate*, so it has to be distinguished before the
plain-gate check or the extension loops on a stale page.

- `captcha_error` — gate plus "the entered text was wrong"; reports the bad
  solve back to 2Captcha for a refund, then re-prompts
- `captcha` — the gate
- `dates` — openings found
- `empty` — a month view with no openings
- `unknown` — not a page we understand; the panel stays out of the way

Dates are detected **positively**, from `<h4>` headings and from
`appointment_showDay.do` links independently. "No appointments" is only a
secondary signal, so if the portal rewords that sentence an empty month
degrades to `empty` rather than to a false "found".

## Tests

```
npm install
npm test
```

Every assertion prints, and the run ends in `all passed` or a count of what
failed — so the suite reports its own size rather than this page trying to keep
a number up to date.

Nine files, all run against pages saved from the live portal (`test/fixtures/`,
including both realm 1419 and realm 692):

| File | What it pins |
|---|---|
| `parser.test.js` | Page classification and date extraction against real markup |
| `alarm.test.js` | The poll alarm: one at a time, whose tab, what fires |
| `arm.test.js` | Which pages may arm an alarm, and which must never |
| `cycle.test.js` | A whole poll cycle across consecutive page loads |
| `recover.test.js` | The failure ladder, and that it never comes to rest |
| `fallback.test.js` | The page driving the poll itself when the worker is unreachable |
| `deadlock.test.js` | That every state schedules a next step — and that booking states never do |
| `hints.test.js` | What the solver is told, and that it only asserts what it has seen |

If the portal changes its markup, this is what tells you.

## Fixtures

`test/fixtures/` holds seven pages saved from the live portal, covering the whole
flow:

| Fixture | Stage | Classifies as |
|---|---|---|
| `live_captcha.html` | Captcha gate (realm 1419) | `captcha` |
| `live_realm692.html` | Captcha gate (realm 692) | `captcha` |
| `live_empty_month.html` | Month view, nothing open | `empty` |
| `live_month_with_dates.html` | Month view **with openings** | `dates` |
| `live_day_view.html` | Time slots for a chosen date | `day` |
| `live_german_dates.html` | Month view with openings, German locale | `dates` |
| `live_booking_form.html` | Booking form + its own captcha | `booking` |

These pages caught four bugs that inference alone would have missed:

**1. Phantom openings.** Month-nav arrows, language switchers and day-view links
all carry a full `DD.MM.YYYY` `dateStr`. A parser scanning links or page text
for dates reports openings on pages that have none — crying wolf on every poll.

**2. The day view is not a month listing.** It links on to the booking form and
its own links carry the date you already picked. Misreading it as `dates` means
the poller reloads *while you are booking*, throwing the slot away. It is
identified by its `appointment_showForm.do` link and polling is suppressed.

**3. The booking form carries a captcha too** — but its submit button is
`action:appointment_addAppointment`, which books the appointment. Treated as an
ordinary gate, auto-solve would have submitted the form with empty personal
details and burned the slot. It is told apart by its *visible* personal-detail
fields (the month gate has the same field names, but hidden), and on it the
extension only enlarges the image and offers to type the code into the page —
never solves, never submits, never polls.

**4. Dead date links.** Openings are found from `<h4>` headings *and* from
`showDay.do` links; headings are read first and carry no href, so a date found
that way rendered as a dead `#` link until the href was backfilled from the
matching link.

**5. Re-checking follows the page, not your settings.** Every stage carries its
own `locationCode` / `realmId` / `categoryId` — the gate and booking form in
hidden inputs, the month and day views in their links. Navigation reads them
from the page and falls back to settings only when the page carries none.
Reading settings first meant that re-checking a page from a different category
silently navigated you into the category in your settings instead.

Two further behaviours the fixtures drive:

- **Re-checking navigates by `GET`; it never calls `location.reload()`.** The
  month page is the response to a POSTed captcha form, so reloading it asks
  Chrome to re-submit and raises a *Confirm Form Resubmission* interstitial
  instead of fetching the page.
- **The displayed month is read from the page's own `MM/YYYY` heading**, and
  month arrows are found by their `go-next.gif` / `go-previous.gif` images —
  they carry no CSS class, and matching on the href alone picks up the language
  switcher instead.

### Page states

`parser.js` sorts every page into one of eight states, in this order — order
matters, since several pages carry a captcha and several carry dates:

`blocked` → `booking` → `captcha_error` → `captcha` → `day` → `dates` →
`empty` → `unknown`

Every state except two schedules something. `empty` and `dates` poll at the
normal interval; `captcha` and `captcha_error` schedule only while auto-solving
is waiting out a run of failures; `blocked` backs off and returns; `unknown`
re-checks at the normal interval, but only when the timer is what brought the
tab there — a page you opened yourself is left alone.

The two exceptions are `day` and `booking`, which schedule **nothing**. That is
what keeps the worker from reloading out from under a booking, and it is checked
by `deadlock.test.js` in both directions: every other state must schedule a next
step, and these two must not.
