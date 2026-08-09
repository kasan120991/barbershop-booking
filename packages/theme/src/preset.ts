/**
 * The Francis Cutz PrimeVue preset.
 *
 * Extends Aura rather than replacing it, so every component inherits sensible
 * structure and only the colour semantics change.
 *
 * `francisDarkPreset` is what the staff app runs on — pinned dark, because the shop
 * tablet must not flip to light because somebody changed an iPad setting.
 * `francisLightPreset` exists for the public site, which has no such constraint and is
 * read outdoors on a phone as often as anywhere else.
 *
 * Both are built from the same ramps in `brand.ts`, so the shop looks like one shop.
 */

import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

import { ACCENT_INK, brass, charcoal, danger } from './brand.js';

/** Shared between both schemes — the accent behaves the same either way. */
const primary = {
  color: brass[500],
  contrastColor: ACCENT_INK,
  hoverColor: brass[400],
  activeColor: brass[600],
};

const focusRing = {
  width: '3px',
  style: 'solid',
  color: 'rgba(212, 162, 76, 0.45)',
  offset: '1px',
};

export const francisDarkPreset = definePreset(Aura, {
  semantic: {
    primary: brass,
    colorScheme: {
      dark: {
        surface: charcoal,
        primary,
        focusRing,
        content: {
          background: charcoal[900],
          borderColor: charcoal[700],
          color: charcoal[50],
        },
        formField: {
          background: charcoal[800],
          borderColor: charcoal[700],
          color: charcoal[50],
          placeholderColor: charcoal[500],
          focusBorderColor: brass[500],
          invalidBorderColor: danger.base,
        },
        text: {
          color: charcoal[50],
          mutedColor: charcoal[300],
        },
      },
    },
  },
});

/**
 * The light scheme, for the public site.
 *
 * The ground is bone (`charcoal[50]`) rather than white, and the text is charcoal
 * rather than black — the same warm bias that keeps the dark app from reading as
 * generic keeps this from reading as a default Bootstrap page.
 *
 * The accent stays amber on a light ground, where it needs to be a shade deeper to
 * hold contrast against bone: `brass[700]` for text and borders, `brass[500]` for
 * fills that carry dark ink on top.
 */
export const francisLightPreset = definePreset(Aura, {
  semantic: {
    primary: brass,
    colorScheme: {
      light: {
        surface: charcoal,
        primary: {
          ...primary,
          hoverColor: brass[600],
          activeColor: brass[700],
        },
        focusRing,
        content: {
          background: '#ffffff',
          borderColor: charcoal[200],
          color: charcoal[900],
        },
        formField: {
          background: '#ffffff',
          borderColor: charcoal[200],
          color: charcoal[900],
          placeholderColor: charcoal[400],
          focusBorderColor: brass[600],
          invalidBorderColor: danger.base,
        },
        text: {
          color: charcoal[900],
          mutedColor: charcoal[500],
        },
      },
    },
  },
});
