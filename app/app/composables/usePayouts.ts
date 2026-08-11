/**
 * One barber's money — what they took, what Stripe holds, and moving it.
 *
 * Three reads with genuinely different lifetimes, which is why they are three calls rather
 * than one summary endpoint:
 *
 * - `summary` is today's takings, and changes whenever a cut is paid for.
 * - `balance` is live from Stripe and is the figure a cash-out is decided against, so it
 *   is never cached anywhere — including here between visits.
 * - `payouts` is history, and only changes when money actually moves.
 *
 * The fee shown to a barber comes from `instantPayoutFeeCents` in `shared`, the same
 * function the server quotes from. A dialog computing its own version is how somebody ends
 * up agreeing to one number and being charged another.
 */

import {
  instantPayoutFeeCents,
  type BalanceDto,
  type EarningsSummaryDto,
  type PayoutDto,
} from '@francis/shared';

export function usePayouts() {
  const api = useApi();

  const summary = useState<EarningsSummaryDto | null>('payouts:summary', () => null);
  const balance = useState<BalanceDto | null>('payouts:balance', () => null);
  const payouts = useState<PayoutDto[]>('payouts:list', () => []);
  const loading = useState<boolean>('payouts:loading', () => false);
  const cashingOut = useState<boolean>('payouts:cashingOut', () => false);

  /**
   * A chair with no Stripe account 409s on the balance, which is an answer rather than a
   * fault — the page simply has no money to show yet. Held separately so the caller can
   * tell "nothing there" from "could not ask".
   */
  const balanceUnavailable = useState<boolean>('payouts:balanceUnavailable', () => false);

  /**
   * All three requests are started before the first `await`, and that is load-bearing.
   *
   * During SSR the Nuxt instance context is only available synchronously; a fetch issued
   * *after* an await has lost it, and `useApi`'s cookie forwarding goes with it. Fetching
   * the balance in a second step did exactly that — the server rendered "could not reach
   * Stripe" while the client rendered the real figure, which showed up as a hydration
   * mismatch and, worse, as a wrong sentence on first paint.
   *
   * `allSettled` rather than `all` because the balance is the one that legitimately fails:
   * a chair with no Stripe account 409s, and the takings and history below are still true.
   */
  async function refresh(barberId: string): Promise<void> {
    loading.value = true;
    balanceUnavailable.value = false;

    try {
      const [today, history, live] = await Promise.allSettled([
        api<EarningsSummaryDto>(`/barbers/${barberId}/earnings`),
        api<{ payouts: PayoutDto[] }>(`/barbers/${barberId}/payouts`),
        api<BalanceDto>(`/barbers/${barberId}/balance`),
      ]);

      if (today.status === 'fulfilled') summary.value = today.value;
      if (history.status === 'fulfilled') payouts.value = history.value.payouts;

      if (live.status === 'fulfilled') {
        balance.value = live.value;
      } else {
        balance.value = null;
        balanceUnavailable.value = true;
      }
    } finally {
      loading.value = false;
    }
  }

  async function cashOut(barberId: string, amountCents: number): Promise<PayoutDto> {
    cashingOut.value = true;
    try {
      const payout = await api<PayoutDto>(`/barbers/${barberId}/payouts/instant`, {
        method: 'POST',
        body: { amountCents },
      });
      // Both the balance and the history just changed; neither can be guessed locally.
      await refresh(barberId);
      return payout;
    } finally {
      cashingOut.value = false;
    }
  }

  /** What Stripe would take for moving this much, by their published rate. */
  function quote(amountCents: number) {
    const feeCents = instantPayoutFeeCents(amountCents);
    return { amountCents, feeCents, netCents: amountCents - feeCents };
  }

  /**
   * What instant payout fees have cost this chair over the payouts we hold.
   *
   * On the page because the cost of the habit is the thing a barber cannot see from any
   * single press — four pounds of convenience over a month reads differently to ninety
   * cents once.
   */
  const feesPaidCents = computed(() =>
    payouts.value.reduce((total, payout) => total + payout.feeCents, 0),
  );

  const instantPayoutCount = computed(
    () => payouts.value.filter((payout) => payout.type === 'INSTANT').length,
  );

  return {
    summary,
    balance,
    payouts,
    loading,
    cashingOut,
    balanceUnavailable,
    refresh,
    cashOut,
    quote,
    feesPaidCents,
    instantPayoutCount,
  };
}
