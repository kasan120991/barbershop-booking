/**
 * A barber's Stripe Connect account.
 *
 * Card money goes straight into the barber's own account — the shop never holds it — so
 * everything here is scoped to one chair and the server refuses any other. There is no
 * list: an admin who needs to see everyone reads each chair through the same endpoint.
 *
 * Two separate reads, deliberately:
 *
 * - `refresh()` reads the **mirror** we keep on `Barber`. Cheap, no Stripe call, and
 *   what every page load uses.
 * - `syncFromStripe()` re-reads the live account. Only on the way back from onboarding,
 *   where the `account.updated` webhook has usually not landed yet and the mirror is
 *   about to tell the barber they still have not started.
 */

import type { ConnectStatusDto, OnboardingLinkDto } from '@francis/shared';

export function useConnect() {
  const api = useApi();

  const status = useState<ConnectStatusDto | null>('connect:status', () => null);
  const loading = useState<boolean>('connect:loading', () => false);
  /** Held separately from `loading`: the button spins while the card stays readable. */
  const starting = useState<boolean>('connect:starting', () => false);

  async function refresh(barberId: string): Promise<void> {
    loading.value = true;
    try {
      status.value = await api<ConnectStatusDto>(`/barbers/${barberId}/connect`);
    } finally {
      loading.value = false;
    }
  }

  async function syncFromStripe(barberId: string): Promise<ConnectStatusDto> {
    loading.value = true;
    try {
      const fresh = await api<ConnectStatusDto>(`/barbers/${barberId}/connect/refresh`, {
        method: 'POST',
      });
      status.value = fresh;
      return fresh;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Mints a hosted onboarding link and leaves the app for it.
   *
   * `window.location.href`, not `navigateTo` — this is a full navigation to stripe.com,
   * and the router would try to resolve it as an internal route. The link is single-use
   * and expires in minutes, which is why it is never stored: every attempt gets a new one.
   *
   * `starting` is deliberately left true. The redirect is in flight and the tab is on its
   * way out; clearing it would flash an enabled button for the moment in between and
   * invite a second tap that mints a second link.
   */
  async function startOnboarding(barberId: string): Promise<void> {
    starting.value = true;
    try {
      const link = await api<OnboardingLinkDto>(`/barbers/${barberId}/connect/onboarding-link`, {
        method: 'POST',
      });
      window.location.href = link.url;
    } catch (error) {
      starting.value = false;
      throw error;
    }
  }

  return { status, loading, starting, refresh, syncFromStripe, startOnboarding };
}
