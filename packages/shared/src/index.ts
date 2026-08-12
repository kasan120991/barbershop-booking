/**
 * @francis/shared — the API contract shared by the server and both frontends.
 *
 * This package MUST stay runtime-agnostic: no Prisma, no Express, no Vue, no Node
 * built-ins, no `process.env`. It is bundled into the browser, so importing Prisma
 * here would ship a database client to the client.
 */

export * from './calendar-lanes.js';
export * from './contracts/index.js';
export * from './duration.js';
export * from './enums.js';
export * from './events.js';
export * from './money.js';
export * from './phone.js';
export * from './privacy.js';
export * from './schedule-rules.js';
export * from './time.js';
