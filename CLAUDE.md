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
| `booking` app | Public online booking **and** a locked-down `/kiosk` route |
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
server/            @francis/server    Express 5 + Prisma + MySQL + Socket.IO + Stripe
app/               @francis/app       Nuxt 4 + PrimeVue — STAFF (admin + barber), authenticated
booking/           @francis/booking   Nuxt 4 + PrimeVue — PUBLIC booking + /kiosk
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

---

## Realtime

- Rooms: `shop` (all staff), `barber:{id}`, `kiosk`, `display`.
- Handshake auth reuses the same `Session` / `Device` lookup as the HTTP middleware.
- Event payload map lives in `shared/src/events.ts`, so renaming an event breaks the build on the
  server and both frontends at once.
- **`kiosk` and `display` rooms get a redacted payload** — first name + last initial only, never a
  full phone number. That screen faces the whole shop.

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
- Validate every request body, query, and param with a zod schema from `shared`. Parse inline with
  `schema.parse(req.body)` — a thrown `ZodError` is already converted to the shared 400 envelope by
  `errorHandler`, and Express 5 forwards async rejections there. That keeps the parsed value typed
  instead of arriving as `any` on a request property.
- Database-backed tests share one database, so **scope every `deleteMany`/`updateMany` in a test to
  that file's own fixtures**. Each test file owns an email domain (`@auth.test`, `@devices.test`);
  an unscoped write will silently break whatever file vitest runs in parallel with it.
- Prisma models `PascalCase` singular; enum values `SCREAMING_SNAKE_CASE`.
- API routes are `/api/<resource>` in plural kebab-case.
- Vue components `PascalCase`; composables `useThing()`.
- Prefer PrimeVue components over hand-rolled UI. **Use the `primevue` MCP** to check component
  APIs rather than guessing — PrimeVue 5 differs from v3/v4 in props and theming. `validate_usage`
  confirms a prop still exists before you write the markup.
- **Colour lives in exactly two files**: `app/app/theme/preset.ts` (PrimeVue tokens) and
  `app/app/assets/css/main.css` (app tokens). Components reference custom properties, never hex.
- **The shell is "two hats".** The owner holds both roles, so `useShopMode()` decides whether the
  rail shows the *Shop* nav or the *My chair* nav; a BARBER-only account is pinned to `chair` and
  the switch is not rendered at all. Nav is data in `useNavigation()`, not markup — add a
  destination there, once.
- **Mode is a cookie, not localStorage**, because the rail renders during SSR and localStorage does
  not exist there. Using it would send the wrong nav and visibly swap after hydration.
- **Hiding a nav link is not access control.** `ADMIN_ONLY_PATHS` is derived from the same nav model
  and enforced in the route guard, and the API enforces it again. All three, always.
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
kiosk → Stripe Connect → payouts & rent → reporting → deploy → *(post-MVP)* Vapi.

The user directs each phase. Do not jump ahead into a later phase unasked.
