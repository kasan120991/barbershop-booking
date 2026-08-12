import { describe, expect, it } from 'vitest';

import { assignLanes } from './calendar-lanes.js';

const span = (startMinute: number, endMinute: number) => ({ startMinute, endMinute });

describe('assignLanes', () => {
  it('gives a lone block the whole column', () => {
    expect(assignLanes([span(600, 660)])).toEqual([{ lane: 0, laneCount: 1 }]);
  });

  it('splits two overlapping blocks side by side', () => {
    // The mockup's pair: 10:00–11:00 and 10:30–11:15.
    expect(assignLanes([span(600, 660), span(630, 675)])).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it('does not narrow a block that touches without overlapping', () => {
    // Back to back is not concurrent — end is exclusive.
    expect(assignLanes([span(600, 660), span(660, 720)])).toEqual([
      { lane: 0, laneCount: 1 },
      { lane: 0, laneCount: 1 },
    ]);
  });

  it('scopes laneCount to the overlap cluster, not the whole day', () => {
    const placements = assignLanes([
      span(540, 600), // 9:00 alone
      span(600, 660), // 10:00 ┐ overlap
      span(630, 675), // 10:30 ┘
      span(720, 765), // 12:00 alone again
    ]);
    expect(placements[0]).toEqual({ lane: 0, laneCount: 1 });
    expect(placements[1]).toEqual({ lane: 0, laneCount: 2 });
    expect(placements[2]).toEqual({ lane: 1, laneCount: 2 });
    expect(placements[3]).toEqual({ lane: 0, laneCount: 1 });
  });

  it('reuses a freed lane within a cluster and counts the true maximum', () => {
    // A long block spans two short ones that do not overlap each other: the
    // second short one takes the freed lane, and the cluster needs two lanes.
    const placements = assignLanes([
      span(600, 720), // 10:00–12:00
      span(600, 645), // 10:00–10:45
      span(660, 705), // 11:00–11:45 — fits where the 10:00–10:45 one was
    ]);
    expect(placements[0]).toEqual({ lane: 0, laneCount: 2 });
    expect(placements[1]).toEqual({ lane: 1, laneCount: 2 });
    expect(placements[2]).toEqual({ lane: 1, laneCount: 2 });
  });

  it('chains transitive overlap into one cluster', () => {
    // A overlaps B, B overlaps C, but A and C never touch — still one cluster,
    // so the widths agree while any of them are on screen together.
    const placements = assignLanes([span(600, 660), span(645, 720), span(705, 765)]);
    expect(placements.map((p) => p.laneCount)).toEqual([2, 2, 2]);
    expect(placements[0]!.lane).toBe(0);
    expect(placements[1]!.lane).toBe(1);
    expect(placements[2]!.lane).toBe(0); // reuses A's freed lane
  });

  it('handles three genuinely concurrent blocks', () => {
    const placements = assignLanes([span(600, 700), span(610, 690), span(620, 680)]);
    expect(placements.map((p) => p.lane).sort()).toEqual([0, 1, 2]);
    expect(placements.every((p) => p.laneCount === 3)).toBe(true);
  });

  it('is order-independent in the placements it returns', () => {
    // Same blocks, shuffled input — each block keeps its own placement.
    const sorted = assignLanes([span(600, 660), span(630, 675)]);
    const shuffled = assignLanes([span(630, 675), span(600, 660)]);
    expect(shuffled[1]).toEqual(sorted[0]);
    expect(shuffled[0]).toEqual(sorted[1]);
  });

  it('returns nothing for nothing', () => {
    expect(assignLanes([])).toEqual([]);
  });
});
