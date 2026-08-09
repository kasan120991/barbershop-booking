/**
 * The palette — "Brass & Charcoal".
 *
 * The one place these hex values exist. Two apps consume them now: the staff app,
 * which is pinned dark, and the public booking site, which is not obliged to be. That
 * is exactly why this moved out of `app/`: the previous rule was "colour lives in
 * exactly two files", and a second app that copied both would quietly have made it
 * four — the same drift that produced four different paddings for one input class.
 *
 * The ramps are the brand. How a given surface uses them is each app's business.
 */

/**
 * Amber. Works as both a fill and as text on the charcoal ground, which is what lets
 * it be the accent without a second colour for links.
 */
export const brass = {
  50: '#fbf5e9',
  100: '#f4e6c6',
  200: '#ecd5a0',
  300: '#e3c379',
  400: '#dbb45d',
  500: '#d4a24c',
  600: '#c08f3f',
  700: '#a1762f',
  800: '#7d5b23',
  900: '#573f18',
  950: '#2f220d',
} as const;

/**
 * Charcoal, warmed slightly toward the amber rather than a default cool grey.
 *
 * That single decision is most of what stops the dark app reading as generic dark
 * mode, and it is why the light end of the ramp is bone rather than white.
 */
export const charcoal = {
  0: '#ffffff',
  50: '#f4f2ee',
  100: '#e4e0d9',
  200: '#c9c4ba',
  300: '#a39d93',
  400: '#7d7770',
  500: '#6f6a63',
  600: '#4b4743',
  700: '#33333a',
  800: '#26262c',
  900: '#1e1e23',
  950: '#17171b',
} as const;

/**
 * Failure states only — declines, locked accounts, no-shows. Never decorative.
 *
 * Keeping the brand accent amber rather than red is what makes that possible: red gets
 * to mean exactly one thing.
 */
export const danger = {
  base: '#d2645c',
  ink: '#eab8b3',
  wash: 'rgba(210, 100, 92, 0.09)',
  line: 'rgba(210, 100, 92, 0.4)',
} as const;

/** Ink on the accent — dark enough to read on amber at small sizes. */
export const ACCENT_INK = '#1a1408';

export const FONT_DISPLAY =
  "ui-sans-serif, 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const FONT_BODY =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
