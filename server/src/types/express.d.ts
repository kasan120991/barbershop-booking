/**
 * Every request carries a `requestId`, echoed in the error envelope and the
 * `x-request-id` response header, so a client reporting "it failed" maps to
 * exactly one log line.
 *
 * Deliberately NOT named `id`: pino-http augments `http.IncomingMessage` with
 * `id: ReqId` (which permits a number), and Express's `Request` inherits it. Our
 * own name keeps the type honestly `string`. Assigned by the `requestId`
 * middleware, which must be mounted first.
 */
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export {};
