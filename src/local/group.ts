// ============================================================
// local/group.ts — collapse near-duplicate subscriptions
// ============================================================
//
// WHY (2026-09-12, reported by the reader as "it repeats a lot"): BGG's notice
// feed emits ONE NOTICE PER IMAGE. A single game that picked up 30 image
// uploads arrived as 30 separate "subscriptions" — all titled "Custom Models",
// all with the same parent game, each with its own image/NNNNNNN url. That was
// 30 of the 50 entries in one night's manifest.
//
// Rendered one-per-section, that is 30 near-identical blocks. A model asked to
// write the digest would probably have collapsed them on its own; the
// code-written stub path faithfully wrote every one, trading invention for
// repetition.
//
// Grouping is deliberately conservative. Two entries merge only when their
// type, title and parent all match AND the caller says they are safe to merge
// — which in practice means both are stubs with no fetchable content. Merging
// two real threads that happened to share a title would merge their CONTENT,
// a worse bug than the one being fixed.

import type { ManifestEntry } from '../agent';

// The identity two entries must share to be considered the same thing.
// Joined with a character that cannot appear in a BGG title or type.
function keyOf(entry: ManifestEntry): string {
  return [entry.type, entry.parentName ?? '', entry.title].join('\u0000');
}

export function groupDuplicateEntries(
  entries: ManifestEntry[],
  // True when this entry may be merged with an identical-looking sibling.
  isGroupable: (entry: ManifestEntry) => boolean,
): ManifestEntry[][] {
  const groups: ManifestEntry[][] = [];
  const openGroups = new Map<string, ManifestEntry[]>();

  for (const entry of entries) {
    if (!isGroupable(entry)) {
      // Keeps its own section, and never joins or opens a group.
      groups.push([entry]);
      continue;
    }

    const key = keyOf(entry);
    const open = openGroups.get(key);
    if (open) {
      open.push(entry);
      continue;
    }

    // A new group takes the position of its FIRST member, so the ranked order
    // built in interests.ts survives grouping.
    const fresh = [entry];
    openGroups.set(key, fresh);
    groups.push(fresh);
  }

  return groups;
}
