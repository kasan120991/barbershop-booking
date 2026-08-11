/**
 * "Welcome back" — without ever being told who anybody is.
 *
 * The public half of the client lookup. The staff app asks a number *whose it is*; this
 * asks whether a number and a name go together, and gets back a boolean. Nothing else
 * comes over the wire — not the surname, not the visit count, not the fact that the
 * number is known at all when the name is wrong.
 *
 * That is not caution for its own sake. A phone number is an **unverified** identity here
 * — there is no OTP and no account — so a call that answered "who owns this number?" on
 * a lobby tablet or a public website would be a directory of the shop's customers, one
 * guess at a time. Requiring the name means a `true` only ever confirms what the caller
 * already believed.
 *
 * What it buys the customer: a returning client stops being asked for a last name the
 * server was going to ignore anyway. `findOrCreateClient` is `update: {}`, so the stored
 * name wins regardless of what the form sends.
 */

import type { RecogniseClientResponse } from '@francis/shared';

/** Long enough that typing a name does not fire a request per letter. */
const DEBOUNCE_MS = 400;

export function useRecognise() {
  const api = useApi();

  const recognised = ref(false);
  const checking = ref(false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;

  /**
   * Both halves, or nothing. A partial pair is somebody mid-keystroke, and asking about
   * it would be both useless and a request per character.
   */
  function check(phone: string, firstName: string): void {
    clearTimeout(timer);

    const digits = phone.replace(/\D/g, '');
    const name = firstName.trim();

    // Any change un-recognises until proven otherwise — a greeting left standing while
    // the number underneath it changes is worse than no greeting.
    recognised.value = false;

    if (digits.length !== 10 || name.length === 0) {
      checking.value = false;
      return;
    }

    checking.value = true;
    const mine = ++sequence;

    timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await api<RecogniseClientResponse>('/clients/recognise', {
            method: 'POST',
            body: { phone, firstName: name },
          });

          // A slower earlier answer must not overwrite a newer one.
          if (mine !== sequence) return;
          recognised.value = response.recognised;
        } catch {
          /**
           * Silence on failure, deliberately.
           *
           * There is nothing useful to say: the greeting is a courtesy, the form works
           * without it, and the endpoint is rate-limited — a customer who trips that
           * should see the form they were already filling in, not an error about a
           * feature they never asked for.
           */
          if (mine === sequence) recognised.value = false;
        } finally {
          if (mine === sequence) checking.value = false;
        }
      })();
    }, DEBOUNCE_MS);
  }

  function reset(): void {
    clearTimeout(timer);
    sequence += 1;
    recognised.value = false;
    checking.value = false;
  }

  onUnmounted(() => clearTimeout(timer));

  return { recognised, checking, check, reset };
}
