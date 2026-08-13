# Francis Cutz — Shop OS

Booking, walk-in queue, point of sale, and barber payouts for the Francis Cutz barbershop.

Barbers rent a booth, keep 100% of every cut, and cash out their own card earnings daily. Clients
book online or walk in and join a live queue on the shop tablet.

<!-- SCREENSHOT SLOT
     Capture two or three screenshots and drop them in docs/screenshots/, then uncomment:

     ![Public booking](docs/screenshots/booking.png)
     ![In-shop kiosk queue](docs/screenshots/kiosk.png)

     Run `pnpm dev` with seeded demo data and shoot at 1440×900. The kiosk queue is the most
     distinctive screen in the project — lead with it. This repo currently has no images at all,
     and a reader who won't clone it has nothing to look at. -->

## Packages

| Package | Path | What it is |
|---|---|---|
| `@francis/shared` | `packages/shared` | API contract — zod schemas, types, socket events, shared helpers |
| `@francis/server` | `server` | Express 5 · Prisma · MySQL · Socket.IO · Stripe Connect |
| `@francis/app` | `app` | Nuxt 4 · PrimeVue — staff app (admin + barber), authenticated |
| `@francis/booking` | `booking` | Nuxt 4 · PrimeVue — public booking site + in-shop `/kiosk` |

## The parts worth reading

Booking software is mostly forms. These are the parts that weren't.

**One schema package is the API contract.** `@francis/shared` holds the zod schemas, types, and
socket event definitions, and all three consumers — the server, the staff app, and the booking site
— import from it. The server validates requests against the same schema the clients build them
from, so a field can't drift between API and UI without the typecheck failing across the workspace.
This is the whole reason the project is a monorepo rather than three repos.

**The payout model drove the money design.** Barbers rent a booth and keep 100% of every cut, which
means the shop never owns their card revenue — it passes through. That's Stripe Connect, with each
barber cashing out their own earnings daily rather than waiting on a shop payroll run. All money is
stored as **integer cents**; nothing about a payout is allowed to depend on float arithmetic.

**The walk-in queue is the realtime surface.** A client joins on the shop tablet at `/kiosk` and the
queue updates on every staff device over Socket.IO. Walk-ins and online bookings compete for the
same chairs, so the queue and the appointment schedule have to agree about who is next — that
reconciliation is the hardest logic in the project.

**Times are stored UTC, and the server pins `TZ` rather than reconfiguring MySQL.** The local MySQL
instance runs in the machine's timezone and is shared with other projects, so changing its global
`time_zone` would have been a fix that broke someone else's database. Pinning the process was the
smaller blast radius.

## Requirements

- **Node 22+** — `nvm use 22`
- **pnpm 11** — `corepack enable pnpm`
- **MAMP** — provides MySQL on port **8889** (`root`/`root`)
- A **Stripe** account with Connect enabled (test mode is fine for development)

## Setup

1. Start MySQL from the MAMP app.
2. Create a database named `francis_cutz` (phpMyAdmin, or the command below).

```bash
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h 127.0.0.1 -P 8889 -uroot -proot \
  -e "CREATE DATABASE IF NOT EXISTS francis_cutz CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
```

```bash
pnpm install
cp server/.env.example server/.env   # fill in Stripe keys
pnpm db:migrate                      # apply migrations
pnpm db:seed                         # shop settings, services, demo barbers
pnpm dev                             # server + app + booking
```

To run the database-backed tests, create the separate test database once:

```bash
/Applications/MAMP/Library/bin/mysql80/bin/mysql -h 127.0.0.1 -P 8889 -uroot -proot \
  -e "CREATE DATABASE IF NOT EXISTS francis_cutz_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
pnpm --filter @francis/server db:test:setup
```

| App | URL |
|---|---|
| Staff app | http://localhost:3000 |
| Public booking | http://localhost:3001 |
| In-shop kiosk | http://localhost:3001/kiosk |
| API | http://localhost:4000 |

## Common commands

```bash
pnpm dev              # everything
pnpm dev:server       # just the API
pnpm typecheck        # whole workspace
pnpm test
pnpm db:studio        # Prisma Studio
```

## Notes

- All money is stored as **integer cents**. All times are stored **UTC**.
- MAMP's MySQL runs in the machine's local timezone and is shared with other projects, so the
  server pins `TZ=UTC` instead of changing MySQL's global `time_zone`.
- Stripe runs in **test mode** locally. Use `stripe listen --forward-to localhost:4000/api/stripe/webhook`
  to receive webhooks, and card `4242 4242 4242 4242` to pay.
- Architecture decisions and the rules contributors must follow live in [`CLAUDE.md`](./CLAUDE.md).
