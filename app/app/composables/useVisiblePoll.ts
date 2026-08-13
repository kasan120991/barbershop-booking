/**
 * A slow poll that sleeps while nobody is looking.
 *
 * `useQueue.poll` held the only copy of this until the calendar wanted one; the schedule
 * and the chair screen would have been the third and fourth. Same argument as
 * `useDayLineup`: the second copy is where two screens start disagreeing.
 *
 * **This is the backstop under the socket, not a substitute for it.** Socket.IO reconnects
 * by itself from a link that drops loudly, and `appointment:changed` resumes with it. What
 * this covers is the link that dies quietly while reporting itself healthy — where a frozen
 * calendar looks exactly like a quiet Tuesday — and the gap during a reconnect, because
 * unlike the queue board there is no connect-time backfill for appointments. There cannot
 * be one: three pages read three different ranges, so there is no single payload to send.
 *
 * Skips while the tab is hidden and catches up the moment it is shown again. The shop
 * tablet sits on one screen most of the day, and a timer running in a background tab is
 * load nobody is looking at.
 */
export function useVisiblePoll(intervalMs: number, tick: () => void): void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const run = () => {
    if (document.visibilityState === 'visible') tick();
  };

  onMounted(() => {
    timer = setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
  });

  onUnmounted(() => {
    if (timer !== undefined) clearInterval(timer);
    document.removeEventListener('visibilitychange', run);
  });
}
