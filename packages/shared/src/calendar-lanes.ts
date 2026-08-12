/**
 * Lane assignment for the calendar views.
 *
 * Two appointments at the same time must sit side by side, not on top of each
 * other. Each block gets a lane (its horizontal slot) and a laneCount (how many
 * ways its overlap cluster is divided), so a lone block spans its whole column
 * and only genuinely concurrent blocks share the width.
 *
 * Pure minute arithmetic — instants become minutes-of-day before they get here,
 * which is also what keeps a 23- or 25-hour day out of scope: on the wall clock
 * the blocks are where the wall clock says.
 */

export interface LaneSpan {
  startMinute: number;
  endMinute: number;
}

export interface LanePlacement {
  /** 0-based horizontal slot within the cluster. */
  lane: number;
  /** How many lanes the cluster needs; a block's width is 1/laneCount. */
  laneCount: number;
}

/**
 * Assigns lanes greedily: blocks are visited in start order (ties: longer first,
 * then input order) and take the first lane whose previous occupant has ended.
 * `laneCount` is settled per connected overlap cluster — a run of blocks that
 * transitively overlap — so an isolated block is never narrowed by a busy hour
 * elsewhere in the day.
 *
 * Returns placements parallel to the input array.
 */
export function assignLanes(spans: readonly LaneSpan[]): LanePlacement[] {
  const order = spans
    .map((_, i) => i)
    .sort(
      (a, b) =>
        spans[a]!.startMinute - spans[b]!.startMinute ||
        spans[b]!.endMinute - spans[a]!.endMinute ||
        a - b,
    );

  const placements = new Array<LanePlacement>(spans.length);
  let laneEnds: number[] = [];
  let cluster: number[] = [];
  let clusterEnd = -1;

  const closeCluster = (): void => {
    for (const i of cluster) placements[i]!.laneCount = laneEnds.length;
    laneEnds = [];
    cluster = [];
  };

  for (const i of order) {
    const span = spans[i]!;
    if (cluster.length > 0 && span.startMinute >= clusterEnd) closeCluster();

    let lane = laneEnds.findIndex((end) => end <= span.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.endMinute);
    } else {
      laneEnds[lane] = span.endMinute;
    }

    placements[i] = { lane, laneCount: 0 };
    cluster.push(i);
    clusterEnd = Math.max(clusterEnd, span.endMinute);
  }
  closeCluster();

  return placements;
}
