# Francis Cutz — Shop OS

Operations platform for the Francis Cutz barbershop. Not just a booking app — four systems in one:

1. **Booking** — clients book a barber online or in the shop.
2. **Walk-in queue** — a live waitlist running alongside the appointment calendar.
3. **Point of sale** — payment taken after the cut, by card or cash.
4. **Barber payouts** — each barber cashes out their own card earnings, daily.

The shop runs on **booth rent**: barbers keep 100% of every cut and pay the shop fixed rent.
Card money flows **directly into each barber's own Stripe account** and never touches a shop
balance — so there is no commission ledger and no chargeback exposure for the shop. Rent is
tracked in-app and settled offline.

---

## Locked product decisions

Do not silently redesign around these. If a task seems to require changing one, stop and ask.

| Area | Decision |
|---|---|
| Walk-ins | Live queue with position + estimated wait; barbers call "next" |
| Barber pay | Booth rent — barber keeps 100%, no per-cut commission |
| Payment timing | Pay **after** service only; no deposits, no card on file |
| Client identity | Phone number, **unverified** — no SMS OTP |
| Stripe | Connect **direct charges** on the barber's connected account, no application fee |
| Cash out | Automatic daily payout (free) **+** manual Instant Payout button (~1.5% fee) |
| Rent | Tracked in-app, marked paid offline (cash/Zelle/check) |
| `booking` app | Public online booking **and** locked-down `/kiosk` and `/display` routes |
| Roles | `ADMIN` and `BARBER` — a **set**, because the owner also cuts hair |
| Services & hours | Fully shop-controlled — admin owns menu, prices, durations, schedules |
| Notifications | None in v1 — in-app and on-screen only |
| Scope | Single location, USD only, no retail product sales |
| Post-MVP | Vapi AI receptionist will handle front-desk tasks by phone |

---

## Workspace layout

pnpm workspace monorepo. Node 22+, pnpm 11 (via corepack).

```
packages/shared/   @francis/shared    the API contract — zod schemas, types, socket events, pure helpers
packages/theme/    @francis/theme     the palette and the PrimeVue presets, dark and light
server/            @francis/server    Express 5 + Prisma + MySQL + Socket.IO + Stripe
app/               @francis/app       Nuxt 4 + PrimeVue — STAFF (admin + barber), authenticated, :3000
booking/           @francis/booking   Nuxt 4 + PrimeVue — PUBLIC booking + /kiosk, :3001
```

### Dependency rules — enforce these

- **`shared` is runtime-agnostic.** No Prisma, no Express, no Vue, no Node built-ins, no `process.env`.
  It gets imported into a browser bundle. The moment it imports Prisma, a database client ships to
  the client.
- **`shared` may not import from any other workspace package.** It is a leaf.
- **`app` and `booking` never import from `server`.** They talk to it over HTTP and Socket.IO, and
  they share types only via `shared`.
- **Prisma types stay in `server`.** To send a model to a frontend, map it to a zod-defined DTO from
  `shared`. That mapping boundary is what stops `passwordHash`, `stripeAccountId`, and client phone
  numbers from leaking into a response by accident.
- `shared` exports **TypeScript source**, not a build artifact. Both Nuxt apps must list it in
  `build.transpile`. The server runs `tsx` in dev and bundles it with `tsup` for production.

---

## Non-negotiable engineering rules

**Money is always integer cents.** Never a float, never a JS number of dollars. Fields are named
`*Cents` (`priceCents`, `tipCents`, `totalCents`). Formatting for display happens once, in
`shared/src/money.ts`.

**Never trust a client-supplied amount.** Prices are always recomputed server-side from `Service`
rows before creating a PaymentIntent.

**Times are stored UTC.** The shop timezone lives in `ShopSettings`. All slot arithmetic goes
through a timezone-aware library (Luxon or `date-fns-tz`) — never raw `Date` math. Weekly recurring
schedules cross DST boundaries twice a year and naive arithmetic silently shifts every appointment
by an hour.

> The local MAMP MySQL runs in the machine's timezone (**EDT**), not UTC, and it is shared with
> other projects — so do not change its global `time_zone`. Instead the server process pins
> `TZ=UTC` (see `server/.env.example`), and every stored instant is written by the app rather than
> by a database-side `CURRENT_TIMESTAMP` default. Keep it that way when the schema lands.

**Snapshot prices and durations.** `AppointmentService` and `QueueEntryService` store their own
`priceCents` and `durationMinutes` copied at booking time. Editing the service menu must never
rewrite the history or the revenue of a past cut.

**Sockets are broadcast-only.** Every mutation goes over authenticated REST; the server emits
afterward. Never accept a write over a socket event — it would duplicate auth, validation, and
audit logging in a second place that will drift.

**Business logic lives in `server/src/services/`.** Plain functions taking plain arguments — no
`req`, no `res`, no Express coupling. Routes parse, authorize, and delegate. This is what lets the
Vapi voice receptionist reuse the exact same booking path later instead of reimplementing it (and
inheriting none of its safety).

**Queue order is derived, never stored.** Sort by `(priority DESC, joinedAt ASC)` and compute
position on read. A stored `position` integer that gets reshuffled is a race-condition factory.

**Audit every money movement**, queue reorder, appointment status change, and role change.

---

## The three pieces of real logic

Everything else is CRUD. These are where the bugs will be, so they are pure functions over a
fetched snapshot and carry required unit tests.

### `services/availability.ts`
For a barber + service set + date: start from `BarberSchedule` for that weekday, subtract
`ScheduleException`, intersect with `ShopHours` minus `ShopClosure`, subtract non-cancelled
`Appointment` ranges, subtract time committed to the live queue, then emit slots at the configured
granularity that fit the total requested duration.

### The public booking site

- **`enforceOnlineRules` is a separate flag from `enforceMinimumNotice`**, and both are false for
  staff. `onlineBookingEnabled`, `Service.bookableOnline` and `Barber.acceptsOnline` govern the
  *internet*, not the shop — switching online booking off must never stop the desk taking one
  over the counter. Every test of these asserts both halves.
- **`GET /services` and `GET /barbers` do NOT filter on those flags.** The kiosk reads the same
  two endpoints and needs the walk-in-only rows, so the list stays complete, the client filters
  for display, and the server refuses at write time. Display is a courtesy; the write check is
  the boundary.
- **"Any barber" is resolved in the client**, by asking every eligible barber for availability
  and merging. The API has no unassigned appointment and should not: the double-booking lock is
  per barber per day, and there is nothing to lock without one. Picking a time therefore picks a
  person, and the confirmation names them.
- **`GET /appointments/token/:token`** is the read half of the cancel link. Without it a
  bookmarked cancel page could only ask "cancel your appointment?" with no idea which one. It
  returns nothing the link holder did not type in themselves — no phone, no surname — because a
  link gets forwarded.

### `services/booking.ts` — double-booking prevention
MySQL cannot express "no overlapping ranges" as a unique constraint. Every booking write runs in a
transaction that first takes a row lock on a per-barber-per-day `BarberDayLock` row
(`SELECT ... FOR UPDATE`), re-checks overlap **inside** the lock, then inserts. Every path that
creates an appointment must use it — online, kiosk, staff, and later Vapi. No exceptions.

### `services/queue.ts` — the estimator
The queue is not a naive FIFO; it must respect booked appointments or it will seat a walk-in into a
slot someone reserved online. For each barber, walk forward from now consuming the gaps between
their booked appointments, assigning each waiting entry the first gap that fits its duration, and
produce `estimatedReadyAt`. "Any barber" entries go to whichever eligible barber frees up first.
Recomputed on every queue or appointment mutation, then broadcast.

Settled while building it:

- **`estimatedReadyAt` is the seat time, not the finish time.** "Ready for you at 2:45" is the
  number a waiting person wants, and it is what the field name says.
- **Assignment is a projection, not a claim.** An "anyone" entry shows an estimate against
  whichever chair frees first, and that moves as the board moves. `callNext` is the only thing
  that attaches them — which is also why an unclaimed entry blocks nobody's online calendar.
  Blocking every barber on their behalf would be a guess, and a pessimistic one.
- **`QueueChairState.freeFrom` is measured before the waiting line is allocated**, so it answers
  "is this barber available" rather than "when does their line run out". Measure it after and a
  barber stands idle beside a card reading *free from 1:44*.
- **The estimator's own input never includes queue time.** It schedules against appointments only;
  `getAvailability` then subtracts both. That ordering is what keeps it a one-way dependency
  instead of the queue rescheduling around itself and walking everyone later on every refresh.
- **A short cut may land in a gap ahead of a longer one already in the line.** Deliberate: the
  longer cut could not have used that gap and its own time is unchanged.
- **One active entry per client**, enforced in the service — MySQL cannot express "unique among
  rows in these three statuses". A kiosk double-tap and a line-jumping re-join are the same two
  rows.
- `callNext` is the queue's one real race and takes `SELECT ... FOR UPDATE` on the candidate row,
  re-checking status inside the lock. `refreshQueueEstimates` sorts its updates by id so two
  concurrent refreshes take row locks in the same order and cannot deadlock.
- **Appointment mutations recompute the queue too** — `createAppointment`, `cancelAppointment` and
  `updateAppointmentStatus` all call `refreshQueueEstimates(now)`. The calendar and the line share
  one day, so booking a cut takes time the board has already promised somebody standing in the
  shop. `now` is threaded through rather than read from the clock, or a booking made against an
  injected clock recomputes against the real one and the test asserts on a different world than
  the code answers about.

---

## Realtime

- Rooms: `shop` (all staff), `barber:{id}`, `kiosk`, `display`.
- Handshake auth reuses the same `Session` / `Device` lookup as the HTTP middleware.
- Event payload map lives in `shared/src/events.ts`, so renaming an event breaks the build on the
  server and both frontends at once.
- **`kiosk` and `display` rooms get a redacted payload** — first name + last initial only, never a
  full phone number. That screen faces the whole shop.

Settled while building it:

- **The room is the privacy boundary, and it is decided from the principal alone.** `rooms.ts`
  works it out at handshake; there is no "join" message to forge, because `ClientToServerEvents`
  is empty.
- **Two events, not one with a union payload.** `queue:updated` carries the full board to `shop`;
  `queue:public` carries the redacted one to `kiosk`/`display`. Sending the wrong shape to the
  wrong room is then a compile error rather than a privacy incident.
- **Everything broadcasts from `refreshQueueEstimates`**, the one function every mutation already
  calls. Emitting from the routes would mean the same line in five handlers, and `POST /queue`
  does not share the others' response helper — so that is exactly the one that would be missed.
- **`realtime/broadcast.ts` holds the socket handle, separately from `realtime/index.ts`**, because
  the server needs to read the queue on connect and the queue service needs to emit. In one file
  that is an import cycle that happens to work until something reorders it.
- **The socket handshake rejects**, where the HTTP middleware only resolves. An unidentified
  request may still be a legitimate public booking; an unidentified socket has no room to join.
- **A new connection is sent the current board immediately**, so a client that reconnects after a
  dropped link is right at once rather than at the next mutation — which on a quiet afternoon
  could be an hour.
- **`closeRealtime()` must run before `httpServer.close()`.** An idle websocket is an open
  connection and the HTTP server waits for it forever, so leaving it turns every deploy into a
  ten-second wait for the shutdown backstop.
- **A poll still runs underneath, at a minute.** Not for a link that drops loudly — Socket.IO
  reconnects by itself — but for one that dies quietly while reporting itself healthy, where a
  frozen board looks exactly like a quiet morning.
- **A rejected handshake never signs anyone out.** It happens routinely on a server restart; the
  REST layer is the authority on the session.

---

## Payments (Stripe Connect, direct charges)

- **Express** connected accounts, onboarded via Stripe-hosted Account Links. Set the payout
  schedule to daily automatic at creation.
- Create the PaymentIntent **on the connected account** (`{ stripeAccount }`) with **no**
  `application_fee_amount`. The barber is merchant of record and their account bears Stripe's fee.
- Gate taking payment on `charges_enabled`; surface `payouts_enabled` in the barber view.
- **Capture flow (v1):** no reader hardware. The barber taps "Take payment" and the app shows a QR
  code / short link to a checkout page in `booking` running Payment Element against that barber's
  account. Tip is selected there. Stripe Terminal is a later phase.
- **Cash** is a first-class `Payment` row with `method: CASH` and no Stripe object.
- **Instant payout** requires a **debit card** as external account, not just a bank. Always show
  the exact fee before confirming.
- **Webhooks:** one endpoint, signature-verified, **raw body**, idempotent by `event.id` persisted
  in `WebhookEvent`. Connected-account events arrive with `event.account` — route by that.

---

## Auth & security

- **Staff:** email + argon2id password → DB-backed `Session` in an httpOnly, SameSite=Lax, Secure
  cookie (`fc_session`). Sessions are **12 hours absolute, never sliding**. Barbers may only
  read/write their own appointments, payments, payouts, and rent — use `requireBarberSelfOrAdmin`.
- **CSRF:** double-submit, bound to the session row. `fc_csrf` is deliberately *not* httpOnly; the
  client echoes it back as `x-csrf-token` and it is compared against `Session.csrfTokenHash`.
  Comparing against the cookie alone would prove nothing. Required on every non-GET with a session.
- **Two principals, one union.** `req.auth` is `{ kind: 'user', ... } | { kind: 'device', ... }`.
  Keep it a discriminated union — a device has no `roles`, so `requireRole(ADMIN)` can never be
  satisfied by a kiosk, and the compiler enforces that rather than a runtime check.
- **Hashing:** argon2id for passwords (low entropy, needs to be slow); **SHA-256** for session,
  CSRF, and device tokens and pairing codes (256-bit random, nothing to brute-force — argon2 there
  would add ~100 ms per request for nothing).
- **Kiosk:** admin issues a pairing code; the device exchanges it once for a device token sent as
  `x-device-token`. The token never expires — an admin revokes it, which clears the token outright.
  Narrow scope — join queue, read the board. It cannot read client history, list phone numbers, or
  take payment. Device requests are CSRF-exempt: a header credential cannot be forged cross-site.
- **Removing a screen is two steps: revoke, then delete.** `DELETE /devices/:id` refuses anything
  not already revoked, because one click on a list row must not be able to unpair a tablet that is
  working in the shop — revoking is the deliberate step that stops it, and it warns. The delete is
  audited with the device's *label* in `before`, and it is the only device action that is:
  `AuditLog.actorDeviceId` is a bare string with no foreign key, so every queue join that kiosk
  ever made would otherwise point at an id nothing can resolve.
- **`KIOSK` and `DISPLAY` are a permission, not a label.** Only a kiosk may `POST /queue`; the wall
  display is read-only and is refused. Both read the same redacted board.
- **The pairing response is the only time a screen is told its own type**, so the client stores it
  beside the token (`fc_device_type`) and each route refuses the other's job up front. Nothing else
  returns it — not `/queue/board`, not the handshake — so dropping it means a reload cannot re-learn
  it, and `/kiosk` on a display-paired tablet runs the entire join flow before 403-ing *after* the
  customer has typed their phone number.
- **The in-shop client must never send credentials** — no `withCredentials` on its socket, no
  `credentials: 'include'` on its fetches. A session cookie beats a device token on *both*
  transports (deliberately: a signed-in barber on the shop tablet is themselves), and cookies
  ignore ports, so a browser used for both apps on one host would otherwise put the kiosk in the
  `shop` room and put full phone numbers on a screen facing the room. Nothing on the server can
  tell the two cases apart; `realtime.test.ts` pins the precedence so the client rule stays
  load-bearing rather than folklore. It lives in **one** place — `useDeviceScreen()` — and both
  screens build on it, because the failure mode is a second copy that quietly picks up
  `withCredentials`.
- **A 401 on a screen means revoked, not expired.** It clears the stored token *and the board* and
  returns to pairing — the opposite of the staff app, where a 401 means sign in again. There is
  nobody at a kiosk to sign in, and a revoked wall board must not sit there showing names.
- **Lockout:** 10 failed logins locks the account until an admin unlocks it, and locking revokes
  existing sessions. Login also sits behind an IP throttle. Failed logins must return an identical
  response for a wrong password and an unknown email, and must burn equivalent CPU (see
  `getDummyPasswordHash`) or the form becomes a staff-directory oracle.
- **Password reset** is admin-only and in person — v1 has no email or SMS. It returns a temporary
  password once, forces a change at next login, and revokes all sessions.
- **Public booking:** unauthenticated, rate-limited by IP **and** by phone number.
- **Because phones are unverified,** `/me` requires phone **plus** matching first name and returns
  only upcoming appointments — never history, never notes, never the full name. Cancellation links
  use opaque per-appointment tokens, not guessable IDs. Adding OTP later upgrades this cleanly.
- Secrets live in `.env`, never committed. Every app ships an `.env.example`.

---

## Conventions

- TypeScript everywhere, `strict` on, all packages extend `tsconfig.base.json`.
- **Rate limiters go through `lib/rate-limit.ts`**, never `rateLimit()` directly. Its default 429
  body bypasses `errorHandler`, so the envelope both frontends parse is missing and `toApiFailure`
  reports it as `NETWORK` — a refused client saying "could not reach the shop" about a server that
  answered it.
- Validate every request body, query, and param with a zod schema from `shared`. Parse inline with
  `schema.parse(req.body)` — a thrown `ZodError` is already converted to the shared 400 envelope by
  `errorHandler`, and Express 5 forwards async rejections there. That keeps the parsed value typed
  instead of arriving as `any` on a request property.
- **A seed that upserts on an editable column is not idempotent.** `ShopHours` is keyed
  `(dayOfWeek, openMinute)`, so re-seeding after someone had changed Saturday's opening time added
  the old row back *beside* the new one and the shop read as open half an hour early. `ShopHours`
  and `BarberSchedule` both replace the whole set now. Any seed of a table whose natural key
  includes a user-editable value must do the same.
- **Hash test passwords once per file, not per fixture.** argon2 is memory-hard by design, so a
  `beforeEach` that seeds three accounts is a hundred passes in one file and slows the shared suite
  for no coverage — `passwords.test.ts` already owns that path.
- **Bind one server per test file: `const server = app.listen(0)`, then `request(server)`.**
  Passing the Express app to supertest makes it start an ephemeral server and close it again for
  *every request*, and a client socket that outlives its server surfaces as `Error: socket hang up`
  or `Parse Error: Expected HTTP/, RTSP/ or ICE/` — with no stack into our code, in whichever file
  happened to be running. It read as database contention for two phases and is not: it is
  connection churn, unrelated to whatever the failing test was about. Close the server in an
  `afterAll`.
- Database-backed tests share one database, so **scope every `deleteMany`/`updateMany` in a test to
  that file's own fixtures**. Each test file owns an email domain (`@auth.test`, `@devices.test`,
  `@catalog.test`). Equally, **never assert on a global list by index** — `barbers[0]` is whatever
  another file happened to create; find your own fixture by name.
- **Server tests run serially** (`fileParallelism: false`). Scoped filters stop files seeing each
  other's *data* but cannot stop InnoDB lock contention on shared indexes, which surfaces as
  "Transaction failed due to a write conflict or a deadlock" in whichever file lost the race.
- **Fire-and-forget writes are skipped under test** (`touchSession`, `touchDevice`). Un-awaited by
  design, they can still be in flight when the next test deletes the row. Argon2 also runs at a
  reduced cost in tests — memory-hard by design, and repeated hashing starves a parallel suite.
- Prisma models `PascalCase` singular; enum values `SCREAMING_SNAKE_CASE`.
- API routes are `/api/<resource>` in plural kebab-case.
- Vue components `PascalCase`; composables `useThing()`.
- **Title case for anything clickable or scannable** — nav items, buttons, headings, tab and column
  labels, page titles. Lowercase after a hyphen, and leave short articles/prepositions/conjunctions
  lowercase unless they lead: `Walk-in Queue`, `Services & Hours`, `Sign In`, `Take Payment`.
  **Sentence case for anything read**: error messages, hints, help text, empty states, and
  descriptive `aria-label`/`title` attributes. "Incorrect Email Or Password." is the failure mode to
  avoid — server-side messages in `services/` are sentences and stay that way.
- Prefer PrimeVue components over hand-rolled UI. **Use the `primevue` MCP** to check component
  APIs rather than guessing — PrimeVue 5 differs from v3/v4 in props and theming. `validate_usage`
  confirms a prop still exists before you write the markup.
- **Colour literals live in exactly one place — `packages/theme/src/brand.ts`.** Each app then
  owns its own surface tokens (`app/app/assets/css/main.css`, `booking/app/assets/css/main.css`)
  and references custom properties, never hex. This moved out of `app/` when the second app
  arrived: two copies of a palette is how one input class ended up with four different paddings.
  `@primeuix/themes` belongs in `theme`, never in `shared`, which is a leaf that ships to every
  client.
- **Both apps pin their scheme and neither reads `prefers-color-scheme`.** The staff app pins
  dark so a shop tablet cannot flip; the booking site pins light so a customer's OS setting
  cannot restyle a page the shop designed. Same reasoning, opposite direction.
- **`/kiosk` and `/display` are dark inside a light app, and they share `.fcb-screen`** in
  `booking/app/assets/css/main.css` — the charcoal ground plus the PrimeVue field and message
  overrides. It is one class rather than per-layout CSS because these overrides were gated on the
  kiosk layout's own root class, which would have rendered the display's pairing field
  white-on-white on charcoal.
- **The wall display is sized in `--u`, not rem.** `--u: min(1vw, 1.78vh)` on the display shell:
  at 16:9 that is exactly 1% of the width (what the design was drawn in), and the `vh` term takes
  over on a shorter panel so type shrinks instead of the queue falling off the bottom. Rem is a
  reading-distance unit; this screen is read from three metres.
- **Nothing on the display scrolls, paginates or shrinks to fit.** `MAX_ROWS` is measured against
  the panel and the surplus becomes "+N more waiting"; more than four chairs pair into two columns
  rather than clipping. A glance gets one look — hiding a queue position behind a count is honest,
  leaving a barber off the board entirely is not. Change a font size there and re-measure.
- **Every phone input is an `InputMask`** with `mask="(999) 999-9999"`, `:auto-clear="false"` and
  `unmask`. All three matter: the default `autoClear` wipes a half-typed number the moment the
  field loses focus, which on the kiosk means somebody glances at the service list and comes back
  to an empty box; and `unmask` keeps the model to ten digits, so what a form holds is data and
  formatting is a display decision made once. Display goes through `formatPhone`; a `tel:` href
  keeps E.164, because that is what a dialler wants.
- **Anything seeding a phone mask from stored data goes through `nationalDigits`.** A mask fills
  left to right, so handing it `+14155550134` renders `(141) 555-5013` and saves that back. Only
  the shop's own number in Services & Hours hydrates from storage today, and it is stored E.164
  like every other phone.
- **Native `<input type="date">`/`type="time"` use the shared `.fc-input` class** — never a local
  copy. It derives padding, radius, font size and height from PrimeVue's own `--p-form-field-*`
  tokens, so a native input matches a `Select` by construction. This existed as four hand-tuned
  copies that had drifted to three paddings and two font sizes before being consolidated; if a new
  control needs different metrics, change the token, not one component.
- **The shell is "two hats".** The owner holds both roles, so `useShopMode()` decides whether the
  rail shows the *Shop* nav or the *My chair* nav; a BARBER-only account is pinned to `chair` and
  the switch is not rendered at all. Nav is data in `useNavigation()`, not markup — add a
  destination there, once.
- **Mode is a cookie, not localStorage**, because the rail renders during SSR and localStorage does
  not exist there. Using it would send the wrong nav and visibly swap after hydration.
- **Hiding a nav link is not access control.** `ADMIN_ONLY_PATHS` is derived from the same nav model
  and enforced in the route guard, and the API enforces it again. All three, always.
- **All HTTP goes through `useApi()`** — it forwards cookies during SSR, attaches the CSRF header,
  and bounces to `/login` on a 401. Endpoints where a 401 is a *legitimate answer* rather than an
  expired session must be added to `AUTH_EXEMPT`: `/auth/me` (signed out), `/auth/login`, and
  `/auth/change-password` (wrong current password). Miss one and the interceptor signs the user out
  mid-form, and the page's own error message becomes unreachable.
- **"Unreachable" is not "signed out."** A network failure sets `connectionError` and shows a banner;
  it must never clear the session or redirect to login, which would send someone to a screen that
  cannot work either.
- **Toasts go through `useNotify()`**, not `useToast()` directly, so severity and duration stay
  consistent. `ToastService` and `ConfirmationService` are already registered by
  `@primevue/nuxt-module` — do not add a plugin for them, it double-registers and warns. The
  *hosts* still have to be mounted: `<Toast>` and `<ConfirmDialog>` live once in the layout, and
  without the latter `confirm.require()` silently does nothing.
- **Never put a top-level `await` in a layout.** A page may be async — it sits inside Suspense and
  `calendar.vue` and `queue.vue` both do it — but awaiting in `layouts/default.vue` makes the whole
  shell an async component, and the `useTemplateRef` further down its setup then runs with no
  instance context and throws `Attempting to define property on object that is not extensible`.
  Every route 500s, and the reported error names an unrelated binding (`auth.displayName`), so the
  message points nowhere near the cause. Fetch in the page, or render client-side.
- **The queue board is polled from the shell, not the page.** The count in the rail and the top bar
  has to stay honest on every screen, so `useQueue().poll()` is called once in `layouts/default.vue`
  and everything else reads the shared state. Phase 7 replaces that one call with a socket
  subscription.
- **Both live counts render inside `<ClientOnly>`**, with the empty state as the fallback so the
  pill holds its space. Not a shortcut around a hydration warning: the `/queue` page's own SSR
  fetch populates the shared state *after* the layout template has already rendered, so a
  server-rendered count genuinely disagrees with the payload the client hydrates from.
- **Queue mutations do not refetch**, unlike every other store here: each one returns the
  recomputed board, because moving one person renumbers everyone behind them.
- Icons come from `@primeicons/vue` as per-icon imports (`@primeicons/vue/calendar`), which
  tree-shakes. Nav icons live in the nav model, not in the layout.
- The staff app is **single-theme dark** on purpose — `.fc-dark` is pinned on `<html>` so the shop
  tablet cannot flip to light mode because someone changed an iPad setting.
- Semantic red is reserved for failure states and is never decorative. The brand accent is amber
  precisely so red keeps meaning exactly one thing.
- Tests: vitest. Required for `availability`, `booking`, and `queue`; optional elsewhere.

## Commands

```bash
pnpm install           # once, at the root
pnpm dev               # run server + app + booking together
pnpm dev:server        # or individually
pnpm typecheck         # must pass across the whole workspace
pnpm test
```

**MySQL comes from MAMP**, not Docker — start it from the MAMP app. It listens on
**port 8889** with `root`/`root`, and this project uses the `francis_cutz` database.

Database-backed tests run against a **separate** `francis_cutz_test` database and must never
touch development data. Create it once with
`pnpm --filter @francis/server db:test:setup`. Tests that need a database skip cleanly when it
is unreachable, so the suite still passes without MAMP running.

## Gotchas

- **Nuxt 4's default `srcDir` is `app/`.** So inside the folder named `app/`, pages live at
  `app/app/pages/`. Same for `booking/app/pages/`. This looks like a mistake and is not — do not
  "fix" it.
- **pnpm 11 blocks dependency install scripts by default.** If a native dependency fails to
  install, add it to **`allowBuilds`** in `pnpm-workspace.yaml` — deliberately, with a reason.
  (This is `allowBuilds` in pnpm 11, not pnpm 10's `onlyBuiltDependencies`.) Prefer dependencies
  with prebuilt binaries — e.g. `@node-rs/argon2` over `argon2` — to avoid the question entirely.
- **Prisma 7 differs sharply from v5/v6.** Run `pnpm --filter @francis/server db:generate`
  explicitly after any schema change — `@prisma/client` has no postinstall. The generator is
  `prisma-client` (not `prisma-client-js`) and `output` is required. Datasource config lives in
  `server/prisma.config.ts`, not in a `datasource url`. Generated row types are named
  `<Model>Model` (`BarberModel`), because the bare name is the query delegate.
- **The MariaDB driver adapter does NOT accept a `url` option.** Passing one produces no
  connection and surfaces as a baffling `pool timeout after 10000ms`. It needs discrete
  host/port/user/password/database — see `server/src/config/database.ts`, which parses
  `DATABASE_URL` into them.
- **`STORED` is a reserved word in MySQL 8** (generated columns). It cannot be a bare column alias
  in raw SQL.
- **PrimeVue 5 needs a licence key.** v4 was MIT; v5 is dual Community/Commercial. The shop
  qualifies for the free Community tier, but the key must be set as `NUXT_PUBLIC_PRIMEUI_LICENSE`
  or PrimeVue may render a licence notice — unacceptable on the customer-facing kiosk. Without a
  key it currently logs a console warning only.
- **SSR auth needs the cookie forwarded AND scoped.** `useApi` copies the incoming `cookie` header
  onto server-side fetches; in production `COOKIE_DOMAIN` must be the shared parent domain or the
  app origin never receives the cookie and SSR auth fails in prod while working in dev.
- **The CSRF token must be re-read from the `fc_csrf` cookie after a reload.** A fresh Pinia store
  has no token and `/auth/me` does not re-issue one, so every mutation 403s. This bites hardest on
  sign-out, which swallows its own errors — the UI returns to the login page looking successful
  while the server session stays valid.

## Build phases

Foundation → server+shared skeleton → schema+seed → auth → catalog & schedules → availability &
booking → queue → realtime → `app` scaffold → admin views → barber views → `booking` scaffold →
kiosk → wall display → Stripe Connect → payouts & rent → reporting → deploy →
*(post-MVP)* Vapi.

The user directs each phase. Do not jump ahead into a later phase unasked.
