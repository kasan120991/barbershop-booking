/**
 * Toasts, wrapped so severity and duration stay consistent.
 *
 * Same reasoning as the staff app's: `useToast()` used directly ends up with five
 * different lifetimes and three spellings of "Something went wrong".
 */

const SUCCESS_LIFE_MS = 3000;
/** Longer, because a failure is read rather than glanced at. */
const ERROR_LIFE_MS = 7000;

export function useNotify() {
  const toast = useToast();

  function notifySuccess(summary: string, detail?: string): void {
    toast.add({
      severity: 'success',
      summary,
      ...(detail === undefined ? {} : { detail }),
      life: SUCCESS_LIFE_MS,
    });
  }

  function notifyError(summary: string, detail?: string): void {
    toast.add({
      severity: 'error',
      summary,
      ...(detail === undefined ? {} : { detail }),
      life: ERROR_LIFE_MS,
    });
  }

  /** The server's own words when it has them — they are written to be read. */
  function notifyApiFailure(error: unknown, fallback = 'Something went wrong.'): void {
    notifyError(toApiFailure(error).message || fallback);
  }

  return { notifySuccess, notifyError, notifyApiFailure };
}
