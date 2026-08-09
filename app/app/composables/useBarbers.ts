/**
 * Roster, weekly schedules and time off for the /barbers page.
 *
 * `useState` rather than `ref`, like `useCatalog` — the roster list and the detail
 * panel both call this, and plain refs would give them separate copies so an edit in
 * one would not show in the other.
 *
 * The schedule and exceptions are keyed by barber id and fetched on selection, since
 * loading every barber's week up front would be several requests for data the admin
 * is not looking at.
 */

import type {
  BarberScheduleDto,
  BarberStaffDto,
  CreateBarberRequest,
  CreatedBarberDto,
  CreateScheduleExceptionRequest,
  ScheduleExceptionDto,
  ShiftRange,
  UpdateBarberRequest,
} from '@francis/shared';

export function useBarbers() {
  const api = useApi();

  const barbers = useState<BarberStaffDto[]>('barbers:list', () => []);
  const selectedId = useState<string | null>('barbers:selected', () => null);
  const shifts = useState<BarberScheduleDto[]>('barbers:shifts', () => []);
  const exceptions = useState<ScheduleExceptionDto[]>('barbers:exceptions', () => []);
  const loading = useState<boolean>('barbers:loading', () => false);

  const selected = computed(
    () => barbers.value.find((barber) => barber.id === selectedId.value) ?? null,
  );

  async function refreshRoster(): Promise<void> {
    const response = await api<{ barbers: BarberStaffDto[] }>('/barbers');
    barbers.value = response.barbers;

    // Keep a selection if it survived; otherwise fall back to the first barber so the
    // detail panel is never empty when a roster exists.
    if (!barbers.value.some((barber) => barber.id === selectedId.value)) {
      selectedId.value = barbers.value[0]?.id ?? null;
    }
  }

  async function loadDetail(barberId: string): Promise<void> {
    loading.value = true;
    try {
      const [scheduleRes, exceptionRes] = await Promise.all([
        api<{ shifts: BarberScheduleDto[] }>(`/barbers/${barberId}/schedule`),
        api<{ exceptions: ScheduleExceptionDto[] }>(`/barbers/${barberId}/exceptions`),
      ]);
      shifts.value = scheduleRes.shifts;
      exceptions.value = exceptionRes.exceptions;
    } finally {
      loading.value = false;
    }
  }

  async function select(barberId: string): Promise<void> {
    selectedId.value = barberId;
    await loadDetail(barberId);
  }

  /** Returns the temporary password, which is shown once and never retrievable again. */
  async function createBarber(input: CreateBarberRequest): Promise<CreatedBarberDto> {
    const response = await api<{ barber: CreatedBarberDto }>('/barbers', {
      method: 'POST',
      body: input,
    });
    await refreshRoster();
    return response.barber;
  }

  async function updateBarber(barberId: string, input: UpdateBarberRequest): Promise<void> {
    await api(`/barbers/${barberId}`, { method: 'PATCH', body: input });
    await refreshRoster();
  }

  /** Throws with every overlapping shift named when the week is invalid. */
  async function saveSchedule(barberId: string, week: ShiftRange[]): Promise<void> {
    const response = await api<{ shifts: BarberScheduleDto[] }>(`/barbers/${barberId}/schedule`, {
      method: 'PUT',
      body: { shifts: week },
    });
    shifts.value = response.shifts;
  }

  async function addException(
    barberId: string,
    input: CreateScheduleExceptionRequest,
  ): Promise<void> {
    await api(`/barbers/${barberId}/exceptions`, { method: 'POST', body: input });
    await loadDetail(barberId);
  }

  async function removeException(exceptionId: string): Promise<void> {
    await api(`/schedule-exceptions/${exceptionId}`, { method: 'DELETE' });
    if (selectedId.value) await loadDetail(selectedId.value);
  }

  return {
    barbers,
    selectedId,
    selected,
    shifts,
    exceptions,
    loading,
    refreshRoster,
    loadDetail,
    select,
    createBarber,
    updateBarber,
    saveSchedule,
    addException,
    removeException,
  };
}
