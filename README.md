# Francis Cutz — Shop OS

Booking, walk-in queue, point of sale, and barber payouts for the Francis Cutz barbershop.

Barbers rent a booth, keep 100% of every cut, and cash out their own card earnings daily. Clients
book online or walk in and join a live queue on the shop tablet.

## Packages

| Package | Path | What it is |
|---|---|---|
| `@francis/shared` | `packages/shared` | API contract — zod schemas, types, socket events, shared helpers |
| `@francis/server` | `server` | Express 5 · Prisma · MySQL · Socket.IO · Stripe Connect |
| `@francis/app` | `app` | Nuxt 4 · PrimeVue — staff app (admin + barber), authenticated |
| `@francis/booking` | `booking` | Nuxt 4 · PrimeVue — public booking site + in-shop `/kiosk` |

## Requirements

- **Node 22+** — `nvm use 22`
- **pnpm 11** — `corepack enable pnpm`
- **Docker** — for local MySQL
- A **Stripe** account with Connect enabled (test mode is fine for development)

## Setup

```bash
pnpm install
cp server/.env.example server/.env   # fill in DATABASE_URL and Stripe keys
pnpm db:up                           # start MySQL
pnpm db:migrate                      # apply migrations
pnpm db:seed                         # shop settings, services, demo barbers
pnpm dev                             # server + app + booking
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
- Stripe runs in **test mode** locally. Use `stripe listen --forward-to localhost:4000/api/stripe/webhook`
  to receive webhooks, and card `4242 4242 4242 4242` to pay.
- Architecture decisions and the rules contributors must follow live in [`CLAUDE.md`](./CLAUDE.md).
