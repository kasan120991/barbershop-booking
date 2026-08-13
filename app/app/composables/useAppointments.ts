/**
 * The book — appointments for a range of days.
 *
 * `GET /appointments` scopes a **barber** to their own book by construction: it overwrites
 * whatever `barberId` they send with their own (`server/src/routes/booking.ts:162-168`),
 * which `appointments.test.ts` pins. An **admin** is a different matter — they get every
 * barber unless they ask for one, which is right for a shop-wide calendar and wrong for
 * "My Day". The owner cuts hair too, so on that page an admin was quietly shown the whole
 * shop's book beside their own chair's walk-ins.
 *
 * So `barberId` is a caller's choice here rather than something left to the server. A
 * barber passing their own id is a no-op; an admin passing it is the whole point.
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

import type { AppointmentChanged, AppointmentDto } from '@francis/shared';

/** Statuses that still occupy the chair. Mirrors `BLOCKING` in `services/booking.ts`. */
export const LIVE_APPOINTMENT_STATUSES = ['BOOKED', 'IN_PROGRESS'] as const;

/** Statuses where the work is not going to happen, or already has not. */
export const VOID_APPOINTMENT_STATUSES = ['CANCELLED', 'NO_SHOW'] as const;

export function useAppointments() {
  const api = useApi();

  const appointments = useState<AppointmentDto[]>('appointments:list', () => []);
  const loading = useState<boolean>('appointments:loading', () => false);

  /**
   * The last change the server announced, or null.
   *
   * A signal, and deliberately not a patch of `appointments`. Three pages read that one
   * list through three different ranges, so a push-assign like the queue's would be right
   * for whichever page happened to be open and quietly wrong for the other two. Each page
   * watches this and refetches the range it asked for; `appointmentChangeTouches` decides
   * whether it has to.
   *
   * Note the two convergent paths: a mutation made HERE patches in place through
   * `replace()`, because somebody who just cancelled an appointment must not wait for a
   * round trip to see it. This signal is for everybody else's writes — another admin at
   * the desk, a client online, the phone.
   *
   * `useState` rather than a `ref` for the same reason as the list: the socket is owned by
   * the shell and the watchers live in pages, and separate copies would mean the handler
   * writing to a signal nobody is listening to.
   */
  const lastChange = useState<AppointmentChanged | null>('appointments:change', () => null);

  /**
   * `quiet` exists for the same reason it does on the queue: a refresh triggered behind
   * a mutation must not blank a list somebody is reading, and must not raise a second
   * toast about a failure the mutation already reported.
   */
  async function loadRange(
    from: string,
    to: string,
    options: { quiet?: boolean; barberId?: string | null } = {},
  ): Promise<void> {
    if (!options.quiet) loading.value = true;
    try {
      const response = await api<{ appointments: AppointmentDto[] }>('/appointments', {
        query: {
          from,
          to,
          ...(options.barberId == null ? {} : { barberId: options.barberId }),
        },
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

  return { appointments, loading, lastChange, loadRange, setStatus, cancel };
}
