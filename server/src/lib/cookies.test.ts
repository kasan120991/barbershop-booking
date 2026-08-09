/**
 * Cookie header parsing.
 *
 * Small enough to look obviously correct and exactly the kind of thing that is not.
 * A socket handshake authenticates on the value this returns, so a header shape it
 * mishandles is a barber who cannot connect — or, worse, one who connects as somebody
 * else.
 */

import { describe, expect, it } from 'vitest';

import { parseCookieHeader } from './cookies.js';

describe('parseCookieHeader', () => {
  it('reads a single cookie', () => {
    expect(parseCookieHeader('fc_session=abc123')).toEqual({ fc_session: 'abc123' });
  });

  it('reads several, ignoring the spacing browsers actually send', () => {
    expect(parseCookieHeader('fc_session=abc;fc_csrf=def;  fc_mode=shop')).toEqual({
      fc_session: 'abc',
      fc_csrf: 'def',
      fc_mode: 'shop',
    });
  });

  it('returns nothing for a request with no cookie header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('keeps a value that contains an equals sign intact', () => {
    // Base64 pads with '=', so splitting on every '=' would truncate the token.
    expect(parseCookieHeader('fc_session=YWJjZA==')).toEqual({ fc_session: 'YWJjZA==' });
  });

  it('decodes percent-encoding, matching what cookie-parser gives the HTTP path', () => {
    expect(parseCookieHeader('name=a%20b')).toEqual({ name: 'a b' });
  });

  it('keeps a malformed escape verbatim rather than throwing', () => {
    // A bad escape must fail the token lookup, not take down the handshake.
    expect(parseCookieHeader('fc_session=%E0%A4%A')).toEqual({ fc_session: '%E0%A4%A' });
  });

  it('skips fragments that are not cookies', () => {
    expect(parseCookieHeader('novalue; =orphan; fc_session=abc')).toEqual({ fc_session: 'abc' });
  });

  it('allows an empty value without inventing one', () => {
    expect(parseCookieHeader('fc_session=')).toEqual({ fc_session: '' });
  });
});
