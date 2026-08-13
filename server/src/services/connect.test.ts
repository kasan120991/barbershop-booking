/**
 * The Connect state machine.
 *
 * Pure and database-free, so it runs everywhere. This is the function both the staff app
 * and the barber view read their wording from, and the cases below are exactly the ones
 * where a plausible-looking implementation says the wrong thing to someone about whether
 * they can be paid today.
 */

import { CONNECT_STATE } from '@francis/shared';
import { describe, expect, it } from 'vitest';

import { deriveConnectState, walletDomainName } from './connect.js';

const ACCOUNT = 'acct_test_123';

describe('deriveConnectState', () => {
  it('is NOT_STARTED only when there is no account at all', () => {
    expect(deriveConnectState(null, { chargesEnabled: false, detailsSubmitted: false })).toBe(
      CONNECT_STATE.NOT_STARTED,
    );
  });

  it('is INCOMPLETE once an account exists but onboarding is unfinished', () => {
    expect(deriveConnectState(ACCOUNT, { chargesEnabled: false, detailsSubmitted: false })).toBe(
      CONNECT_STATE.INCOMPLETE,
    );
  });

  it('is PENDING when everything is submitted but Stripe has not cleared charges', () => {
    expect(deriveConnectState(ACCOUNT, { chargesEnabled: false, detailsSubmitted: true })).toBe(
      CONNECT_STATE.PENDING,
    );
  });

  it('is READY as soon as charges are enabled', () => {
    expect(deriveConnectState(ACCOUNT, { chargesEnabled: true, detailsSubmitted: true })).toBe(
      CONNECT_STATE.READY,
    );
  });

  /**
   * Stripe does enable charges before every requirement is in — an account can be taking
   * money with paperwork still outstanding. Treating that as "not ready" would tell a
   * barber who can be paid right now that they cannot be.
   */
  it('is READY even when details are still outstanding', () => {
    expect(deriveConnectState(ACCOUNT, { chargesEnabled: true, detailsSubmitted: false })).toBe(
      CONNECT_STATE.READY,
    );
  });

  /**
   * The whole reason `payoutsEnabled` is not an input here: it fails on its own, and
   * folding it in would either block a chair that can take money or claim a barber is
   * "all set" when their payout method is missing. It is surfaced as its own field.
   */
  it('does not consider payouts — a chair can charge before it can pay out', () => {
    expect(deriveConnectState(ACCOUNT, { chargesEnabled: true, detailsSubmitted: true })).toBe(
      CONNECT_STATE.READY,
    );
  });
});

describe('walletDomainName', () => {
  /**
   * The gate that decides whether Apple Pay and Google Pay are even attempted.
   *
   * Both wallets require a publicly reachable HTTPS host, so getting this wrong fails in
   * one of two quiet ways: registering a host Stripe will never validate, or skipping a
   * perfectly good one and leaving the buttons hidden with no error anywhere.
   */
  it('accepts a real HTTPS host', () => {
    expect(walletDomainName('https://book.franciscutz.com')).toBe('book.franciscutz.com');
    expect(walletDomainName('https://book.franciscutz.com/pay')).toBe('book.franciscutz.com');
  });

  it('accepts an HTTPS tunnel, which is what makes this testable before launch', () => {
    expect(walletDomainName('https://losing-tess.ngrok-free.dev')).toBe('losing-tess.ngrok-free.dev');
  });

  it('refuses plain HTTP, however public the host', () => {
    // Apple Pay will not run in an insecure context, so registering this would create a
    // domain that never validates and a button that never appears.
    expect(walletDomainName('http://book.franciscutz.com')).toBeNull();
  });

  it('refuses everything local development actually uses', () => {
    expect(walletDomainName('http://localhost:3001')).toBeNull();
    expect(walletDomainName('https://localhost:3001')).toBeNull();
    // The LAN address this shop's own dev config carries.
    expect(walletDomainName('http://192.168.1.175:3001')).toBeNull();
    expect(walletDomainName('https://192.168.1.175:3001')).toBeNull();
    expect(walletDomainName('https://shop-mac.local')).toBeNull();
  });

  it('refuses anything unparseable rather than throwing', () => {
    // This runs inside onboarding. A malformed env var must not take a barber's payout
    // setup down with it.
    expect(walletDomainName('')).toBeNull();
    expect(walletDomainName('not a url')).toBeNull();
  });
});
