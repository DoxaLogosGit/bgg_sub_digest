// ============================================================
// local/validate.ts — is this section's PROSE worth shipping?
// ============================================================
//
// WHY: isTruncatedDigest counts "### [" headers to catch a digest that
// rendered almost nothing. That is the 2026-09-10 failure — 1 section of 31,
// stamped 'complete', emailed [OK], 90 BGG notices cleared and gone.
//
// On the local path CODE writes those headers (see local/section.ts), so they
// are always present and that guard goes blind. Without a prose-level check
// the same failure returns wearing a different hat: a digest that is
// structurally perfect and says nothing.
//
// Thresholds are deliberately loose. This is a FLOOR AGAINST EMPTINESS, not a
// quality score — rejecting honest terse summaries would send good content
// round the retry/split/skip ladder for no gain.

// Below this a "summary" carries no information. "New activity." is 14 chars.
// The shortest genuinely useful summary in the 09-04 digest was 58.
const MIN_SUMMARY_CHARS = 40;

// Phrases observed from a degenerating model standing in for real content.
// The 09-10 re-run produced "See file for details." in all 31 sections; the
// 09-01/02/03 vacuous digests produced "Activity detected." and
// "Content not retrievable".
const FILLER = /^(see (the )?file for details|new activity( detected)?|content not retrievable|activity detected)\.?$/i;

export function sectionDefect(section: string): string | null {
  if (!section.trim()) return 'empty section';

  const summaryMatch = /^\*\*Summary:\*\*[ \t]*(.*)$/m.exec(section);
  if (!summaryMatch) return 'no Summary line';

  const summary = summaryMatch[1].trim();
  if (!summary) return 'empty Summary';
  if (summary.length < MIN_SUMMARY_CHARS) return `Summary too short (${summary.length} chars)`;
  if (FILLER.test(summary)) return 'Summary is filler';

  // A bullet whose whole content is filler does not count as a bullet — that
  // is precisely the 09-10 shape, where every bullet read the same stub.
  const bullets = (section.match(/^[ \t]*[-*][ \t]+\S.*$/gm) ?? [])
    .filter((b) => !FILLER.test(b.replace(/^[ \t]*[-*][ \t]+/, '').trim()));
  if (bullets.length === 0) return 'no bullets under New Activity';

  return null;
}
