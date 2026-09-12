// ============================================================
// local/highlights.ts — the cross-subscription block, cheaply
// ============================================================
//
// The synthesis pass reads ONLY the Summary lines. Feeding 46 assembled
// sections (~31KB, measured 2026-09-12) back to a 9B model would recreate
// exactly the overwhelm this design exists to avoid; the Summary lines are a
// fraction of that and are the material a highlights block is built from.
//
// mechanicalHighlights is the fallback when the model cannot manage even
// that. It needs no model at all: the pipeline already knows in code which
// subscriptions carry replies to the reader, which match a priority title,
// and which belong to a tracked game. Dull, but it cannot be wrong — and a
// digest must never ship without a Highlights block, because
// isMissingHighlights treats that as a defective generation.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';
import { isImageUpload } from '../interests';

// ---- summaryLines ------------------------------------------------
//
// "<title> — <summary>" per section, nothing else.
export function summaryLines(sections: string): string {
  const out: string[] = [];
  let title = '';

  for (const line of sections.split('\n')) {
    // Greedy up to the LAST "](", so a title that itself opens with a bracket
    // survives: "### [[Detective Hawk] Wayfarers ...](https://...)".
    const header = /^###[ \t]+\[(.+)\]\(/.exec(line);
    if (header) { title = header[1]; continue; }

    const summary = /^\*\*Summary:\*\*[ \t]*(.*)$/.exec(line);
    if (summary && title) out.push(`${title} — ${summary[1].trim()}`);
  }

  return out.join('\n');
}

// ---- nameList ----------------------------------------------------
//
// Titles for one bullet: deduplicated, capped, and counted.
//
// 2026-09-12: BGG emits one notice per image, so a game that gained 30 images
// produced "activity in Custom Models, Custom Models, Custom Models, ..."
// thirty times over. A highlight is an index, not an inventory — it must stay
// one readable line whatever the feed does.
const MAX_NAMES = 4;

function nameList(entries: ManifestEntry[]): string {
  const unique = [...new Set(entries.map((e) => e.title))];

  // A repeated title means several notices about the same thing; the count is
  // the information, not the repetition.
  if (unique.length === 1 && entries.length > 1) {
    return `${entries.length} × ${unique[0]}`;
  }

  if (unique.length <= MAX_NAMES) return unique.join(', ');
  return `${unique.slice(0, MAX_NAMES).join(', ')} and ${unique.length - MAX_NAMES} more`;
}

// ---- mechanicalHighlights ----------------------------------------
//
// Built entirely from the manifest. No model, no cost, no invention.
export function mechanicalHighlights(entries: ManifestEntry[], cfg: InterestsConfig): string {
  const lines = ['## ⭐ Highlights', ''];

  const matches = (hay: string | undefined, needles: string[]): boolean =>
    !!hay && needles.some((n) => n && hay.toLowerCase().includes(n.toLowerCase()));

  // Image uploads are excluded from every bullet below. Highlights is what the
  // reader sees first, and 32 image notices on a tracked game would own that
  // bullet and bury the discussion the game is tracked FOR (2026-09-12). They
  // still get their own grouped section further down.
  const notable = entries.filter((e) => !isImageUpload(e));

  // Replies to the reader lead — the one thing here that may be waiting on him.
  // Checked against the FULL list: somebody commenting on the reader's image is
  // still a reply to him.
  const replies = entries.filter((e) => e.selfActivity);
  if (replies.length > 0) {
    lines.push(`- 💬 **Replies to you** — ${replies
      .map((e) => `${e.title}: ${e.selfActivity!.reasons.join('; ')}`)
      .join(' | ')}`);
  }

  const priority = notable.filter((e) => !e.selfActivity && matches(e.title, cfg.priorityTitles));
  if (priority.length > 0) {
    lines.push(`- ⭐ **Priority subscriptions** — ${nameList(priority)}`);
  }

  for (const game of cfg.trackedGames) {
    const hits = notable.filter((e) => matches(e.parentName, [game]) || matches(e.title, [game]));
    if (hits.length > 0) {
      lines.push(`- ⭐ **${game}** — activity in ${nameList(hits)}`);
    }
  }

  // Never emit a bullet-less block: isMissingHighlights would read it as a
  // defective generation and send a perfectly good digest round the retry
  // ladder.
  if (lines.length === 2) {
    lines.push(
      `- ${entries.length} subscription(s) with new activity; none matched your ` +
      `tracked games or priority list tonight.`,
    );
  }

  return lines.join('\n');
}
