import { describe, expect, it } from 'vitest';

import { firstNameOnly, publicDisplayName } from './privacy.js';

describe('publicDisplayName', () => {
  it('shows first name plus last initial', () => {
    expect(publicDisplayName('Darnell', 'Whitaker')).toBe('Darnell W.');
  });

  it('never leaks the full last name to a shop-floor screen', () => {
    expect(publicDisplayName('Darnell', 'Whitaker')).not.toContain('Whitaker');
  });

  it('falls back to the first name when there is no last name', () => {
    expect(publicDisplayName('Darnell')).toBe('Darnell');
    expect(publicDisplayName('Darnell', null)).toBe('Darnell');
    expect(publicDisplayName('Darnell', '  ')).toBe('Darnell');
  });

  it('trims and upper-cases the initial', () => {
    expect(publicDisplayName('  Darnell ', ' whitaker ')).toBe('Darnell W.');
  });

  it('handles a non-ASCII last name without splitting a surrogate pair', () => {
    expect(publicDisplayName('Ana', 'Ñuñez')).toBe('Ana Ñ.');
  });
});

describe('firstNameOnly', () => {
  it('takes the first token', () => {
    expect(firstNameOnly('Darnell')).toBe('Darnell');
    expect(firstNameOnly('Mary Jane')).toBe('Mary');
    expect(firstNameOnly('  Darnell  ')).toBe('Darnell');
  });
});
