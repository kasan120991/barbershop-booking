/**
 * Taking payment on one chair.
 *
 * Two lists that answer opposite questions, and keeping them apart is the point:
 * `tickets` is what still owes money, `payments` is what has already been taken. A screen
 * that had to derive the first from the second would be doing the reconciliation the
 * barber opened it to avoid.
 *
 * Neither request sends a date. The shop day is resolved server-side from `ShopSettings`,
 * because a tablet reports whatever its own clock thinks — and just after midnight on one
 * left in UTC, a browser-computed date makes the evening's takings disappear from a screen
 * that otherwise looks like it is working.
 *
 * Mutations refetch, matching `useDevices` and `useCatalog`: settling a cut removes it
 * from one list and adds it to the other, and hand-merging both is how they drift apart.
 */

import type { PayableTicketDto, PaymentDto, RecordCashPaymentRequest } from '@francis/shared';

export function usePayments() {
  const api = useApi();

  const tickets = useState<PayableTicketDto[]>('payments:tickets', () => []);
  const payments = useState<PaymentDto[]>('payments:today', () => []);
  const loading = useState<boolean>('payments:loading', () => false);
  /** Held apart from `loading` so the confirm button spins while the list stays readable. */
  const saving = useState<boolean>('payments:saving', () => false);

  async function refresh(barberId: string): Promise<void> {
    loading.value = true;
    try {
      const [unpaid, taken] = await Promise.all([
        api<{ tickets: PayableTicketDto[] }>(`/barbers/${barberId}/payable-tickets`),
        api<{ payments: PaymentDto[] }>(`/barbers/${barberId}/payments`),
      ]);
      tickets.value = unpaid.tickets;
      payments.value = taken.payments;
    } finally {
      loading.value = false;
    }
  }

  async function recordCash(input: RecordCashPaymentRequest): Promise<PaymentDto> {
    saving.value = true;
    try {
      const payment = await api<PaymentDto>('/payments/cash', { method: 'POST', body: input });
      await refresh(input.barberId);
      return payment;
    } finally {
      saving.value = false;
    }
  }

  /** Everything taken today, tips included — the number a barber checks at closing. */
  const takenTodayCents = computed(() =>
    payments.value.reduce((total, payment) => total + payment.totalCents, 0),
  );

  return { tickets, payments, loading, saving, refresh, recordCash, takenTodayCents };
}
