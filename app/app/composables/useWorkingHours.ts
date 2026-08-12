/**
 * Resolved working intervals from `GET /working-hours` — the calendar's ground.
 *
 * Stateless on purpose: each calendar view owns exactly one window (a week for
 * `/my-day`, a day for `/calendar`) and refetches when its cursor moves, so a
 * shared cache would only be a place for a stale week to hide. The server scopes
 * a barber to their own chair whatever `barberId` says; passing it anyway is the
 * same both-halves rule as `loadRange`.
 */

import type { WorkingHoursResponse } from '@francis/shared';

export function useWorkingHours() {
  const api = useApi();

  async function loadWorkingHours(
    from: string,
    days: number,
    barberId?: string | null,
  ): Promise<WorkingHoursResponse> {
    return api<WorkingHoursResponse>('/working-hours', {
      query: { from, days, ...(barberId == null ? {} : { barberId }) },
    });
  }

  return { loadWorkingHours };
}
