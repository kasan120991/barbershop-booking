/**
 * Toast notifications, with the conventions applied once.
 *
 * Wrapping `useToast` rather than calling it directly keeps severity, wording and
 * lifetime consistent across screens that will be written weeks apart — and gives
 * one place to change how the shop is told something worked.
 *
 * Durations differ on purpose: a success is a glance, a failure is something you
 * need time to read and act on.
 */

const SUCCESS_LIFE_MS = 3000;
const ERROR_LIFE_MS = 7000;

export function useNotify() {
  const toast = useToast();

  /** "Payment recorded", "Appointment moved" — past tense, states what happened. */
  function notifySuccess(summary: string, detail?: string) {
    toast.add({
      severity: 'success',
      summary,
      ...(detail === undefined ? {} : { detail }),
      life: SUCCESS_LIFE_MS,
    });
  }

  function notifyError(summary: string, detail?: string) {
    toast.add({
      severity: 'error',
      summary,
      ...(detail === undefined ? {} : { detail }),
      life: ERROR_LIFE_MS,
    });
  }

  /**
   * Reports a failed API call using the server's own message, which is already
   * written for a human and knows more about what went wrong than the caller does.
   */
  function notifyApiFailure(error: unknown, fallback = 'Something went wrong.') {
    const failure = toApiFailure(error);
    notifyError(failure.message || fallback);
  }

  return { notifySuccess, notifyError, notifyApiFailure };
}
