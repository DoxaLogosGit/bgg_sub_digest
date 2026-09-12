// ============================================================
// local/section.ts — build the section around the model's prose
// ============================================================
//
// WHY (2026-09-11 spike): asked to produce a whole section, the local model
// wrote a bare "### Question about traits..." with no markdown link. That
// scored 0 sections and would have tripped isTruncatedDigest into a retry,
// then a split, then a skip — for content that was actually fine.
//
// The manifest already holds the title, url, parentName and selfActivity, so
// the code emits every structural line and asks the model only for prose.
// A model that never writes a link cannot write a broken one. It also shrinks
// the local prompt to "summarise this and say who said what", which is what a
// 9B model does well.
//
// PYTHON CONTEXT: both functions are pure. `matchTopics` reads content and
// config; `assembleSection` joins strings. Neither touches disk.

import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

// ---- matchTopics ------------------------------------------------
//
// "Topics Mentioned" used to be the model's job and was routinely invented —
// it is a substring search, which is not a judgement call, so it belongs in
// code where it can be tested.
export function matchTopics(content: string, cfg: InterestsConfig): string[] {
  const haystack = content.toLowerCase();
  const found: string[] = [];

  const add = (label: string): void => {
    if (!found.includes(label)) found.push(label);
  };

  for (const game of cfg.trackedGames) {
    if (game && haystack.includes(game.toLowerCase())) add(game);
  }

  for (const keyword of cfg.keywords) {
    // interests.toml keeps readable entries like "solo / solitaire" or
    // "kickstarter / crowdfunding". The slash separates alternatives rather
    // than being part of the term, so searching for the literal string would
    // never match anything.
    for (const alt of keyword.split('/').map((k) => k.trim()).filter(Boolean)) {
      if (haystack.includes(alt.toLowerCase())) { add(alt); break; }
    }
  }

  return found;
}

// ---- assembleSection --------------------------------------------
//
// `prose` is exactly what the model returned: a "**Summary:**" line and a
// "**New Activity:**" bullet list. Everything around it is ours.
export function assembleSection(entry: ManifestEntry, prose: string, topics: string[]): string {
  const lines: string[] = [`### [${entry.title}](${entry.url})`];

  // Only when set. An empty "*Parent: *" line was a real defect in 2026-09
  // and is the reason this is decided in code rather than described to a model.
  if (entry.parentName) lines.push(`*Parent: ${entry.parentName}*`);

  if (entry.selfActivity && entry.selfActivity.reasons.length > 0) {
    lines.push(`**💬 Replies to you:** ${entry.selfActivity.reasons.join('; ')}`);
  }

  lines.push('', prose.trim(), '');
  lines.push(`**Topics Mentioned:** ${topics.length ? topics.join(', ') : 'none'}`);

  return lines.join('\n');
}
