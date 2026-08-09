/**
 * Catalog data for the /services page.
 *
 * One shared source for all three tabs: the services table needs the barber roster to
 * render the capability column, and the hours editor needs shop settings. Fetching
 * per-tab would mean three copies of the same list drifting apart the moment one is
 * edited.
 *
 * Mutations refetch rather than patching local state. The lists are small, the shop
 * has one admin, and a refetch cannot disagree with the server — which a hand-merged
 * local update eventually will.
 */

import type {
  BarberStaffDto,
  CreateClosureRequest,
  CreateServiceRequest,
  ServiceDto,
  ShopClosureDto,
  ShopSettingsDto,
  UpdateServiceRequest,
  UpdateShopSettingsRequest,
} from '@francis/shared';

/** A service plus the barbers who perform it, as the list endpoint returns it. */
export interface ServiceWithBarbers extends ServiceDto {
  barberIds: string[];
}

export function useCatalog() {
  const api = useApi();

  // `useState`, not `ref` — the page and the dialog both call this composable, and
  // plain refs would give them separate copies. The dialog would then refresh a list
  // nobody is rendering while the page kept showing stale rows.
  const services = useState<ServiceWithBarbers[]>('catalog:services', () => []);
  const barbers = useState<BarberStaffDto[]>('catalog:barbers', () => []);
  const settings = useState<ShopSettingsDto | null>('catalog:settings', () => null);
  const closures = useState<ShopClosureDto[]>('catalog:closures', () => []);
  const loading = useState<boolean>('catalog:loading', () => false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      const [serviceRes, barberRes, settingsRes, closureRes] = await Promise.all([
        api<{ services: ServiceWithBarbers[] }>('/services'),
        api<{ barbers: BarberStaffDto[] }>('/barbers'),
        api<{ settings: ShopSettingsDto }>('/shop-settings'),
        api<{ closures: ShopClosureDto[] }>('/shop-closures'),
      ]);
      services.value = serviceRes.services;
      barbers.value = barberRes.barbers;
      settings.value = settingsRes.settings;
      closures.value = closureRes.closures;
    } finally {
      loading.value = false;
    }
  }

  /** Returns the created service so the caller can act on its id — matching by name would
   *  pick the wrong row the moment two services share one. */
  async function createService(input: CreateServiceRequest): Promise<ServiceDto> {
    const response = await api<{ service: ServiceDto }>('/services', {
      method: 'POST',
      body: input,
    });
    await refresh();
    return response.service;
  }

  async function updateService(serviceId: string, input: UpdateServiceRequest) {
    await api(`/services/${serviceId}`, { method: 'PATCH', body: input });
    await refresh();
  }

  async function setServiceBarbers(serviceId: string, barberIds: string[]) {
    await api(`/services/${serviceId}/barbers`, { method: 'PUT', body: { barberIds } });
    await refresh();
  }

  /** Throws a 409 when the service has been booked; the caller surfaces the message. */
  async function deleteService(serviceId: string) {
    await api(`/services/${serviceId}`, { method: 'DELETE' });
    await refresh();
  }

  async function serviceUsage(serviceId: string): Promise<number> {
    const response = await api<{ usageCount: number }>(`/services/${serviceId}/usage`);
    return response.usageCount;
  }

  async function updateSettings(input: UpdateShopSettingsRequest) {
    await api('/shop-settings', { method: 'PATCH', body: input });
    await refresh();
  }

  async function replaceHours(
    hours: { dayOfWeek: number; openMinute: number; closeMinute: number; isClosed: boolean }[],
  ) {
    await api('/shop-hours', { method: 'PUT', body: { hours } });
    await refresh();
  }

  async function createClosure(input: CreateClosureRequest) {
    await api('/shop-closures', { method: 'POST', body: input });
    await refresh();
  }

  async function deleteClosure(closureId: string) {
    await api(`/shop-closures/${closureId}`, { method: 'DELETE' });
    await refresh();
  }

  return {
    services,
    barbers,
    settings,
    closures,
    loading,
    refresh,
    createService,
    updateService,
    setServiceBarbers,
    deleteService,
    serviceUsage,
    updateSettings,
    replaceHours,
    createClosure,
    deleteClosure,
  };
}
