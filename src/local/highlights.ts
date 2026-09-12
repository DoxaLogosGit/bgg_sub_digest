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

// ---- mechanicalHighlights ----------------------------------------
//
// Built entirely from the manifest. No model, no cost, no invention.
export function mechanicalHighlights(entries: ManifestEntry[], cfg: InterestsConfig): string {
  const lines = ['## ⭐ Highlights', ''];

  const matches = (hay: string | undefined, needles: string[]): boolean =>
    !!hay && needles.some((n) => n && hay.toLowerCase().includes(n.toLowerCase()));

  // Replies to the reader lead — the one thing here that may be waiting on him.
  const replies = entries.filter((e) => e.selfActivity);
  if (replies.length > 0) {
    lines.push(`- 💬 **Replies to you** — ${replies
      .map((e) => `${e.title}: ${e.selfActivity!.reasons.join('; ')}`)
      .join(' | ')}`);
  }

  const priority = entries.filter((e) => !e.selfActivity && matches(e.title, cfg.priorityTitles));
  if (priority.length > 0) {
    lines.push(`- ⭐ **Priority subscriptions** — ${priority.map((e) => e.title).join(', ')}`);
  }

  for (const game of cfg.trackedGames) {
    const hits = entries.filter((e) => matches(e.parentName, [game]) || matches(e.title, [game]));
    if (hits.length > 0) {
      lines.push(`- ⭐ **${game}** — activity in ${hits.map((e) => e.title).join(', ')}`);
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
