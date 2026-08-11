/**
 * The book — appointments for a range of days.
 *
 * `GET /appointments` is **already scoped to whoever is asking**: a barber-only account
 * cannot pass a `barberId` at all, because the route overwrites whatever it is sent with
 * their own (`server/src/routes/booking.ts:162-168`). So `/my-day` asks for a date range
 * and nothing else, and the server decides whose book that is. `appointments.test.ts`
 * pins that behaviour, because this composable's safety rests on it entirely.
 *
 * Two things the endpoint does not do, both handled by the callers:
 *
 * - **No status filter.** Cancellations and no-shows arrive with everything else. They
 *   are worth having — a client who cancelled twice is worth seeing — but not at full
 *   weight, so the page folds them away rather than the composable dropping them.
 * - **No `generatedAt`.** There is no server clock in the response, so anything that
 *   depends on "now" borrows the queue board's `generatedAt` instead of reading the
 *   browser's clock. Same rule as `/queue`.
 */

import type { AppointmentDto } from '@francis/shared';

/** Statuses that still occupy the chair. Mirrors `BLOCKING` in `services/booking.ts`. */
export const LIVE_APPOINTMENT_STATUSES = ['BOOKED', 'IN_PROGRESS'] as const;

/** Statuses where the work is not going to happen, or already has not. */
export const VOID_APPOINTMENT_STATUSES = ['CANCELLED', 'NO_SHOW'] as const;

export function useAppointments() {
  const api = useApi();

  const appointments = useState<AppointmentDto[]>('appointments:list', () => []);
  const loading = useState<boolean>('appointments:loading', () => false);

  /**
   * `quiet` exists for the same reason it does on the queue: a refresh triggered behind
   * a mutation must not blank a list somebody is reading, and must not raise a second
   * toast about a failure the mutation already reported.
   */
  async function loadRange(
    from: string,
    to: string,
    options: { quiet?: boolean } = {},
  ): Promise<void> {
    if (!options.quiet) loading.value = true;
    try {
      const response = await api<{ appointments: AppointmentDto[] }>('/appointments', {
        query: { from, to },
      });
      appointments.value = response.appointments;
    } catch (error) {
      if (!options.quiet) throw error;
    } finally {
      if (!options.quiet) loading.value = false;
    }
  }

  /**
   * Both writes return the updated appointment, so the row is patched in place rather
   * than the whole range refetched. Unlike the queue, moving one appointment does not
   * renumber anything — nothing else on the day changes.
   */
  function replace(updated: AppointmentDto): void {
    appointments.value = appointments.value.map((appointment) =>
      appointment.id === updated.id ? updated : appointment,
    );
  }

  async function setStatus(appointmentId: string, status: string): Promise<void> {
    const response = await api<{ appointment: AppointmentDto }>(
      `/appointments/${appointmentId}/status`,
      { method: 'PATCH', body: { status } },
    );
    replace(response.appointment);
  }

  async function cancel(appointmentId: string, reason?: string): Promise<void> {
    const response = await api<{ appointment: AppointmentDto }>(
      `/appointments/${appointmentId}/cancel`,
      { method: 'POST', body: reason === undefined ? {} : { reason } },
    );
    replace(response.appointment);
  }

  return { appointments, loading, loadRange, setStatus, cancel };
}
