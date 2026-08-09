import { francisPreset } from './app/theme/preset';

export default defineNuxtConfig({
  compatibilityDate: '2026-08-09',
  devtools: { enabled: true },

  modules: ['@primevue/nuxt-module', '@pinia/nuxt'],

  css: ['~/assets/css/main.css'],

  // Both workspace packages export TypeScript source rather than a build artifact, so
  // Vite has to transpile them instead of treating them as prebuilt dependencies.
  build: {
    transpile: ['@francis/shared', '@francis/theme'],
  },

  runtimeConfig: {
    public: {
      /** The Express API. Separate origin, hence credentials + CORS. */
      apiBase: 'http://localhost:4000/api',
      /**
       * PrimeVue 5 Community licence key. Free for this shop, but required —
       * without it PrimeVue logs a licence warning. See app/.env.example.
       *
       * The key name must be exactly `PRIMEUI_LICENSE`: @primevue/nuxt-module reads
       * `runtimeConfig.public.PRIMEUI_LICENSE` verbatim, so the usual camelCase
       * (`primeuiLicense`) is silently ignored and the warning never goes away.
       * Populated from NUXT_PUBLIC_PRIMEUI_LICENSE.
       */
      PRIMEUI_LICENSE: '',
    },
  },

  primevue: {
    options: {
      theme: {
        preset: francisPreset,
        options: {
          // Pinned to a selector that is always present rather than following the
          // OS: the shop tablet must not flip to light mode because someone changed
          // an iPad setting.
          darkModeSelector: '.fc-dark',
          cssLayer: {
            name: 'primevue',
            order: 'theme, base, primevue',
          },
        },
      },
      ripple: false,
    },
  },

  app: {
    head: {
      title: 'Francis Cutz — Staff',
      htmlAttrs: { lang: 'en', class: 'fc-dark' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'color-scheme', content: 'dark' },
        { name: 'theme-color', content: '#17171b' },
      ],
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },
});
