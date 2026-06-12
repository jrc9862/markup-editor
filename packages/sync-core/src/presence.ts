import type { PresenceUser } from './types.js';

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

/** Deterministically pick a presence color from a seed string. */
export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

/** Build a presence identity from a display name. */
export function makePresence(name: string): PresenceUser {
  return { name, color: colorForSeed(name) };
}
