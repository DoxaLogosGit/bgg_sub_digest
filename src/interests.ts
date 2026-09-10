// ============================================================
// interests.ts — priority ranking and chunk splitting
// ============================================================
//
// WHY THIS MODULE EXISTS (2026-09-10): the digest used to hand every
// subscription to the model in one shot and let it decide the ordering from
// the prose rules in INTERESTS.md. That stopped being possible.
//
// nemotron-3-super:cloud degenerates on large one-shot digests. The evidence
// is a clean split — six healthy runs at <=21 subscriptions (09-04 through
// 09-09) and four degenerate ones at >=31 (09-01, 09-02, 09-03, 09-10). The
// 09-10 run read all 31 subscriptions, wrote a Highlights block naming most
// of them, and emitted ONE section; a re-run of the identical workspace
// produced 31 sections each reading "See file for details."
//
// So the digest is now built in chunks small enough to stay in the healthy
// range. That has a consequence: a chunk only sees its own subscriptions, so
// "put the priority ones first" cannot be a judgement the model makes —
// nothing inside a chunk knows what is in the others. Ranking therefore
// happens HERE, over the whole set, before the split. Which is why the
// priority rules had to become machine-readable (interests.toml).
//
// PYTHON CONTEXT: everything here is pure — no I/O, no clock, no mutation of
// arguments. loadInterests (in config.ts) does the file reading.

import type { ManifestEntry } from './agent';

export type { ManifestEntry };

// ---- InterestsConfig -------------------------------------------
//
// The parsed shape of interests.toml. `notes` is free text the pipeline never
// interprets — it exists so rules that are judgements rather than title
// matches ("auction geeklists") still reach the model.
export interface InterestsConfig {
  priorityTitles: string[];
  trackedGames:   string[];
  keywords:       string[];
  notes:          string;
}

// ---- Ranking tiers ---------------------------------------------
//
// Lower sorts earlier. Spelled out as named constants because the ORDER of
// these tiers is the product decision — the numbers themselves are arbitrary.
const TIER_REPLY_TO_YOU  = 0;  // somebody responded to the reader directly
const TIER_PRIORITY      = 1;  // title matches interests.toml priority_titles
const TIER_TRACKED_GAME  = 2;  // parent game is one the reader tracks
const TIER_HAS_PARENT    = 3;  // belongs to some game's forum
const TIER_EVERYTHING    = 4;  // orphan threads, unrelated geeklists

function matchesAny(haystack: string, needles: string[]): boolean {
  if (!haystack) return false;
  const lower = haystack.toLowerCase();
  // Substring rather than equality: BGG titles carry months, prefixes and
  // decoration ("Solitaire Games on Your Table -- September 2026"), so an
  // exact match would never fire.
  return needles.some((n) => n && lower.includes(n.toLowerCase()));
}

// ---- tierOf ----------------------------------------------------
//
// Which ranking tier does this subscription belong to? First match wins, in
// the order below — a subscription is only ever counted once.
export function tierOf(entry: ManifestEntry, cfg: InterestsConfig): number {
  if (entry.selfActivity) return TIER_REPLY_TO_YOU;
  if (matchesAny(entry.title, cfg.priorityTitles)) return TIER_PRIORITY;
  if (entry.parentName && matchesAny(entry.parentName, cfg.trackedGames)) return TIER_TRACKED_GAME;
  if (entry.parentName) return TIER_HAS_PARENT;
  return TIER_EVERYTHING;
}

// ---- rankEntries -----------------------------------------------
//
// Sort the whole manifest into digest order. STABLE within a tier: two
// equally-ranked subscriptions keep their feed order, so the digest does not
// reshuffle itself nightly for no reason.
//
// Array.prototype.sort is guaranteed stable in modern V8, but the decorate-
// sort-undecorate below makes that explicit rather than relying on it.
export function rankEntries(entries: ManifestEntry[], cfg: InterestsConfig): ManifestEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, tier: tierOf(entry, cfg) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((d) => d.entry);
}

// ---- chunkEntries ----------------------------------------------
//
// Split the ranked list into consecutive groups of at most `size`. A pure
// partition: order is preserved, nothing is dropped or duplicated, and no
// empty chunk is ever emitted (an empty chunk would spawn a model run with
// nothing to summarise).
export function chunkEntries(entries: ManifestEntry[], size: number): ManifestEntry[][] {
  const capped = Math.max(1, Math.floor(size));
  const out: ManifestEntry[][] = [];
  for (let i = 0; i < entries.length; i += capped) {
    out.push(entries.slice(i, i + capped));
  }
  return out;
}

// ---- renderInterestsMarkdown -----------------------------------
//
// interests.toml is the single source of truth, but the model reads
// INTERESTS.md (the workspace CLAUDE.md references it by that name). Render
// one from the other at install time so there is nothing to keep in sync.
//
// Deliberately keeps the same headings the old hand-written interests.md
// used, so CLAUDE.md's references ("INTERESTS.md's Priority Subscriptions
// section") keep resolving.
export function renderInterestsMarkdown(cfg: InterestsConfig): string {
  const bullets = (items: string[]): string =>
    items.length ? items.map((i) => `- ${i}`).join('\n') : '- (none)';

  return [
    '# BGG Digest Interests',
    '',
    '*Generated from interests.toml — edit that file, not this one.*',
    '',
    '## Games I\'m Tracking',
    'Highlight any mentions of these games with ⭐:',
    bullets(cfg.trackedGames),
    '',
    '## Keywords to Highlight',
    'Mark content touching these topics with ⭐:',
    bullets(cfg.keywords),
    '',
    '## Priority Subscriptions — Put These First',
    'Subscriptions whose title contains any of these are the most important.',
    'The pipeline has ALREADY sorted them to the top for you — you do not need',
    'to reorder anything, but treat them as the headline material:',
    bullets(cfg.priorityTitles),
    '',
    ...(cfg.notes.trim() ? ['## Additional Notes', '', cfg.notes.trim(), ''] : []),
  ].join('\n');
}
