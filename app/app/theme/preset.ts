/**
 * The Francis Cutz PrimeVue theme — "Brass & Charcoal".
 *
 * Extends Aura rather than replacing it, so every PrimeVue component inherits
 * sensible structure and only the colour semantics change.
 *
 * The neutral ramp is deliberately warm-biased toward the amber rather than a
 * default cool grey. That single decision is most of what stops the app reading as
 * generic dark mode.
 *
 * Semantic red is reserved for failure states — payment declines, locked accounts,
 * no-shows — and is never used decoratively. Keeping the brand accent amber rather
 * than red is what makes that possible.
 */

import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/** Amber. The accent works as both a fill and as text on the charcoal ground. */
const brass = {
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
};

/** Charcoal, warmed slightly. 900 is the app ground; 800 is a raised surface. */
const charcoal = {
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
};

export const francisPreset = definePreset(Aura, {
  semantic: {
    primary: brass,
    colorScheme: {
      dark: {
        surface: charcoal,
        primary: {
          color: brass[500],
          contrastColor: '#1a1408',
          hoverColor: brass[400],
          activeColor: brass[600],
        },
        // Focus ring picks up the accent, matching the approved mockup.
        focusRing: {
          width: '3px',
          style: 'solid',
          color: 'rgba(212, 162, 76, 0.45)',
          offset: '1px',
        },
        content: {
          background: '#1e1e23',
          borderColor: '#33333a',
          color: '#f4f2ee',
        },
        formField: {
          background: '#26262c',
          borderColor: '#33333a',
          color: '#f4f2ee',
          placeholderColor: '#6f6a63',
          focusBorderColor: brass[500],
          invalidBorderColor: '#d2645c',
        },
        text: {
          color: '#f4f2ee',
          mutedColor: '#a39d93',
        },
      },
    },
  },
});
