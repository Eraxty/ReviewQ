// Pixl's economy maths, ported from packages/config (apps/internal-dashboard/
// app/_generated/config.ts in hackclub/pixl, MIT License, Copyright (c) 2026 Pixl)
// so the payout preview matches what the dash shows a reviewer.

const E = {
  pixelValueUsd: 0.1,
  basePayoutUsd: 4,
  maxPayoutUsd: 6,
  payoutSlopeRe: 1875,
  tierRePerHour: [12.5, 15, 18.75, 25],
  levelBands: [
    { throughLevel: 10, rePerLevel: 10 },
    { throughLevel: 50, rePerLevel: 35 },
    { throughLevel: 100, rePerLevel: 70 },
  ],
};

export const PIXEL_VALUE_USD = E.pixelValueUsd;

export function rePerHour(tier) {
  const t = Math.min(Math.max(Math.trunc(tier) || 1, 1), E.tierRePerHour.length);
  return E.tierRePerHour[t - 1];
}

export function reForHours(hours, tier) {
  const h = Number.isFinite(hours) ? Math.max(hours, 0) : 0;
  return h * rePerHour(tier);
}

export function levelForRe(re) {
  let remaining = Number.isFinite(re) ? Math.max(re, 0) : 0;
  let level = 0;
  let prevTop = 0;
  for (const band of E.levelBands) {
    const span = band.throughLevel - prevTop;
    const cost = span * band.rePerLevel;
    if (remaining < cost) return level + Math.floor(remaining / band.rePerLevel);
    remaining -= cost;
    level = band.throughLevel;
    prevTop = band.throughLevel;
  }
  return level;
}

export function payoutUsdPerHour(re) {
  return Math.min(E.basePayoutUsd + Math.max(re, 0) / E.payoutSlopeRe, E.maxPayoutUsd);
}

export function averageUsdPerHourOver(reBefore, reAfter) {
  return payoutUsdPerHour(Math.max(reAfter, reBefore, 0));
}

export function pxPerHourOver(reBefore, reAfter) {
  return averageUsdPerHourOver(reBefore, reAfter) / E.pixelValueUsd;
}
