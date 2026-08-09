/**
 * Process entry point: bind the port, and shut down without dropping work.
 *
 * Graceful shutdown matters more here than in a typical CRUD app — a SIGTERM
 * mid-payment must not abandon a Stripe call between "charge created" and "payment
 * row written". In-flight requests get to finish; new ones stop being accepted.
 */

import { createServer } from 'node:http';

import { createApp } from './app.js';
import { SERVICE_NAME } from './config/constants.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';
import { closeRealtime, createRealtime } from './realtime/index.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

/**
 * Created explicitly rather than left to `app.listen()`, because Socket.IO has to
 * attach to the same server — one port, one origin, and no second thing to open in a
 * firewall or proxy.
 */
const server = createServer(app);
createRealtime(server);

server.listen(env.PORT, env.HOST, () => {
  logger.info(
    { service: SERVICE_NAME, port: env.PORT, host: env.HOST, env: env.NODE_ENV },
    `${SERVICE_NAME} listening on http://${env.HOST}:${env.PORT}`,
  );
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down');

  // Backstop: if a connection refuses to drain, exit anyway rather than hang forever.
  const timer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timer.unref();

  /**
   * Sockets first, and this ordering is load-bearing.
   *
   * `server.close()` stops accepting new connections and waits for open ones to end —
   * and an idle websocket never ends. Leave them open and every shutdown hangs until
   * the backstop above kills the process, which on a deploy means ten seconds of
   * downtime per restart and a non-zero exit code in the logs.
   */
  closeRealtime()
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Error closing realtime connections');
    })
    .finally(() => {
      server.close((error) => {
        if (error) {
          logger.error({ err: error }, 'Error during shutdown');
          process.exit(1);
        }

        // Only after in-flight requests have drained — closing the pool first would
        // fail the very queries we are waiting on.
        disconnectPrisma()
          .catch((disconnectError: unknown) => {
            logger.error({ err: disconnectError }, 'Error disconnecting from the database');
          })
          .finally(() => {
            logger.info('Shutdown complete');
            process.exit(0);
          });
      });
    });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  shutdown('uncaughtException');
});
