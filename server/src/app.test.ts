import { healthResponseSchema } from '@francis/shared';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const app = createApp();

describe('GET /api/health', () => {
  it('returns a payload matching the shared contract', async () => {
    const response = await request(app).get('/api/health').expect(200);

    // The real assertion: the server's response satisfies the schema both Nuxt
    // apps type their fetch against. If these drift, this fails.
    const parsed = healthResponseSchema.safeParse(response.body);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    expect(response.body.status).toBe('ok');
  });

  it('echoes a request id so a report maps to a log line', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('honours an upstream x-request-id across a proxy hop', async () => {
    const response = await request(app)
      .get('/api/health')
      .set('x-request-id', 'upstream-trace-id')
      .expect(200);

    expect(response.headers['x-request-id']).toBe('upstream-trace-id');
  });
});

describe('unknown routes', () => {
  it('returns the shared error envelope, not an Express HTML page', async () => {
    const response = await request(app).get('/api/does-not-exist').expect(404);

    expect(response.body).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    expect(response.body.error.requestId).toBeTruthy();
  });

  it('404s outside the API prefix too', async () => {
    const response = await request(app).get('/nope').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('security headers', () => {
  it('does not advertise Express', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets helmet defaults', async () => {
    const response = await request(app).get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
