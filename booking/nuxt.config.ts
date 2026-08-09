import { francisLightPreset } from '@francis/theme';

export default defineNuxtConfig({
  compatibilityDate: '2026-08-09',
  devtools: { enabled: true },

  // No Pinia. There is no session here, so there is no store to hold one.
  modules: ['@primevue/nuxt-module'],

  css: ['~/assets/css/main.css'],

  // Both workspace packages export TypeScript source rather than a build artifact, so
  // Vite has to transpile them instead of treating them as prebuilt dependencies.
  build: {
    transpile: ['@francis/shared', '@francis/theme'],
  },

  runtimeConfig: {
    public: {
      /** The Express API. Separate origin, hence CORS — see BOOKING_ORIGIN on the server. */
      apiBase: 'http://localhost:4000/api',
      /**
       * PrimeVue 5 Community licence key. The name must be exactly `PRIMEUI_LICENSE`:
       * @primevue/nuxt-module reads `runtimeConfig.public.PRIMEUI_LICENSE` verbatim, so
       * the usual camelCase is silently ignored and the warning never goes away.
       *
       * It matters more here than in the staff app — an unlicensed notice on the page a
       * customer books from is not something the shop should ever ship.
       */
      PRIMEUI_LICENSE: '',
    },
  },

  primevue: {
    options: {
      theme: {
        preset: francisLightPreset,
        options: {
          /**
           * A selector that is never applied, which is the point: the staff app pins
           * `.fc-dark` so a shop tablet cannot flip; this app pins light for the same
           * reason in reverse. A customer's OS preference must not restyle a page the
           * shop has designed.
           */
          darkModeSelector: '.fc-never-dark',
          cssLayer: { name: 'primevue', order: 'theme, base, primevue' },
        },
      },
      ripple: false,
    },
  },

  app: {
    head: {
      title: 'Book an appointment — Francis Cutz',
      htmlAttrs: { lang: 'en' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'color-scheme', content: 'light' },
        { name: 'theme-color', content: '#17171b' },
        {
          name: 'description',
          content:
            'Book a cut at Francis Cutz. Pick your barber, pick a time, pay after your cut.',
        },
      ],
    },
  },

  typescript: { strict: true, typeCheck: false },
});
