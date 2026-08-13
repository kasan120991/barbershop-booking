/**
 * Paired screens — the kiosk by the door, and the wall display later.
 *
 * A short-lived pairing code is the whole handover: an admin issues one, somebody types
 * it into the tablet, and the tablet trades it once for a token that never expires. The
 * code is the only thing a person ever has to carry between the two, which is why it is
 * eight digits and not a 256-bit string.
 *
 * Mutations refetch, matching `useCatalog` — the list is tiny and a refetch cannot
 * disagree with the server, which a hand-merged local update eventually will.
 */

import type { CreateDeviceRequest, CreatedDeviceResponse, DeviceDto } from '@francis/shared';

export function useDevices() {
  const api = useApi();

  const devices = useState<DeviceDto[]>('devices:list', () => []);
  const loading = useState<boolean>('devices:loading', () => false);

  async function refresh(): Promise<void> {
    loading.value = true;
    try {
      devices.value = (await api<{ devices: DeviceDto[] }>('/devices')).devices;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Returns the secret rather than storing it.
   *
   * A pairing code for a screen, the token itself for a voice line — discriminated by
   * `type`. Either way it is shown once and is not retrievable, since the server keeps
   * only its hash, so the caller has to hold it on screen until the admin has finished
   * with it. Putting it in shared state would be a plaintext credential sitting in the
   * app for as long as the tab is open.
   */
  async function createDevice(input: CreateDeviceRequest): Promise<CreatedDeviceResponse> {
    const created = await api<CreatedDeviceResponse>('/devices', { method: 'POST', body: input });
    await refresh();
    return created;
  }

  async function revokeDevice(deviceId: string): Promise<void> {
    await api(`/devices/${deviceId}/revoke`, { method: 'POST' });
    await refresh();
  }

  /**
   * Only ever offered on a revoked row, and the server refuses anything else — a screen
   * has to be stopped before it can be tidied away, so that one click cannot unpair a
   * tablet that is working in the shop.
   */
  async function deleteDevice(deviceId: string): Promise<void> {
    await api(`/devices/${deviceId}`, { method: 'DELETE' });
    await refresh();
  }

  return { devices, loading, refresh, createDevice, revokeDevice, deleteDevice };
}
