/**
 * Booth rent for one chair.
 *
 * Used by both sides of it — the admin panel on `/barbers` and the barber's own `/my-rent` —
 * because they read exactly the same endpoint and differ only in what they are allowed to
 * do with it. The server enforces that difference; this does not pretend to.
 *
 * It owns its own fetching rather than taking rent as a prop from `useBarbers`, which is a
 * deliberate step away from how `ScheduleEditor` and `TimeOffPanel` work. Those take small,
 * always-needed slices; a rent ledger is dozens of charges that most visits to a barber's
 * profile never open, and loading it on every roster click to satisfy a pattern would be
 * paying for it every time to use it rarely.
 *
 * Every mutation refetches. Recording a payment changes a charge's status, the outstanding
 * total and the summary at once, and hand-merging three derived numbers is how they start
 * disagreeing with the server.
 */

import type {
  AllocateRentPaymentRequest,
  AllocatedRentPaymentDto,
  CreateRentChargeRequest,
  RecordRentPaymentRequest,
  RentOverviewDto,
  SaveRentPlanRequest,
} from '@francis/shared';

export function useRent() {
  const api = useApi();

  const overview = useState<RentOverviewDto | null>('rent:overview', () => null);
  const loading = useState<boolean>('rent:loading', () => false);
  const saving = useState<boolean>('rent:saving', () => false);

  async function refresh(barberId: string): Promise<void> {
    loading.value = true;
    try {
      overview.value = await api<RentOverviewDto>(`/barbers/${barberId}/rent`);
    } finally {
      loading.value = false;
    }
  }

  async function savePlan(barberId: string, input: SaveRentPlanRequest): Promise<void> {
    saving.value = true;
    try {
      await api(`/barbers/${barberId}/rent-plan`, { method: 'PUT', body: input });
      await refresh(barberId);
    } finally {
      saving.value = false;
    }
  }

  async function addCharge(barberId: string, input: CreateRentChargeRequest): Promise<void> {
    saving.value = true;
    try {
      await api(`/barbers/${barberId}/rent-charges`, { method: 'POST', body: input });
      await refresh(barberId);
    } finally {
      saving.value = false;
    }
  }

  /**
   * A sum handed over against the chair, spread by the server across the weeks it clears.
   *
   * The one the counter uses. It returns what it settled rather than nothing, so the
   * confirmation can name the weeks — "cleared 3 – 9 Aug and 10 – 16 Aug" is the sentence
   * that stops somebody wondering where their money went.
   */
  async function payChair(
    barberId: string,
    input: AllocateRentPaymentRequest,
  ): Promise<AllocatedRentPaymentDto[]> {
    saving.value = true;
    try {
      const response = await api<{ allocated: AllocatedRentPaymentDto[] }>(
        `/barbers/${barberId}/rent-payments`,
        { method: 'POST', body: input },
      );
      await refresh(barberId);
      return response.allocated;
    } finally {
      saving.value = false;
    }
  }

  async function recordPayment(
    barberId: string,
    chargeId: string,
    input: RecordRentPaymentRequest,
  ): Promise<void> {
    saving.value = true;
    try {
      await api(`/rent-charges/${chargeId}/payments`, { method: 'POST', body: input });
      await refresh(barberId);
    } finally {
      saving.value = false;
    }
  }

  async function waiveCharge(barberId: string, chargeId: string, note: string): Promise<void> {
    saving.value = true;
    try {
      await api(`/rent-charges/${chargeId}/waive`, { method: 'POST', body: { note } });
      await refresh(barberId);
    } finally {
      saving.value = false;
    }
  }

  return {
    overview,
    loading,
    saving,
    refresh,
    savePlan,
    addCharge,
    payChair,
    recordPayment,
    waiveCharge,
  };
}

/**
 * "Aug 10 – 16", or "Jul 27 – Aug 2" when a period crosses a month.
 *
 * The month is named once and stays at the front, because these are `en-US` dates. Dropping
 * it from the *start* instead — which reads correctly as "10 – 16 Aug" — renders here as
 * "10 – Aug 16", a range that appears to begin with a bare number and end in another month.
 *
 * The dates are parsed part by part rather than through `new Date(iso)`, which reads a bare
 * `YYYY-MM-DD` as UTC midnight and then renders it in the browser's zone — far enough west
 * and every period would display a day early.
 */
export function formatPeriod(startIso: string, endIso: string): string {
  const start = plainDate(startIso);
  const end = plainDate(endIso);
  if (start === null || end === null) return `${startIso} – ${endIso}`;

  const startLabel = start.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const endLabel = sameMonth
    ? String(end.getDate())
    : end.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });

  return `${startLabel} – ${endLabel}`;
}

/** A single date, in the same zone-proof way. */
export function formatPlainDate(iso: string): string {
  const date = plainDate(iso);
  if (date === null) return iso;
  return date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function plainDate(iso: string): Date | null {
  const [year, month, day] = iso.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return new Date(year, month - 1, day);
}
