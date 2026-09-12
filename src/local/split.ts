// ============================================================
// local/split.ts — cut a subscription's data under an input cap
// ============================================================
//
// WHY (measured 2026-09-11): the local model returns SILENT EMPTY OUTPUT
// above roughly 3K input tokens. Feeding it the 61KB / 50-item SGOYT geeklist
// produced zero characters and no error at all; 10 items produced all 10
// bullets in 24s.
//
// VRAM is NOT the constraint — the same model sits at 100% GPU even with a
// 32K context (5.6 GB at 8K, 6.4 GB at 32K, on an 8188 MiB card). The cliff
// is the model's ability on long inputs, so the fix is capping the INPUT.
// Do not "fix" a future recurrence by shrinking the context or buying memory.
//
// Parts are cut on BGG's own record boundaries, so no post or item is ever
// halved. Half a post is worse than no post: it reads as complete and is not.
//
// PYTHON CONTEXT: a pure function — no I/O, no clock, no mutation of its
// argument. The caller (local/render.ts) decides what to do with the parts.

// A record starts at a line beginning "[Item by " (geeklists) or "[Post by "
// (threads). Both shapes are produced by agent.ts's formatters — see
// formatGeeklistContent and formatThreadContent.
//
// The lookahead means split() keeps the marker with the record that follows
// it rather than consuming it.
const RECORD_START = /^(?=\[(?:Item|Post) by )/m;

export function splitSubscriptionContent(content: string, maxChars: number): string[] {
  if (!content.trim()) return [];
  if (content.length <= maxChars) return [content];

  const pieces = content.split(RECORD_START);

  // Everything before the first record is the file header, e.g.
  // "=== Geeklist: Solitaire Games on Your Table ===". It is repeated into
  // every part because each part becomes an independent model call with no
  // memory of its siblings.
  const header  = pieces[0].startsWith('[') ? '' : pieces.shift() ?? '';
  const records = pieces;

  // Nothing to split on — a stub file, or a shape we do not recognise.
  // Pass it through whole rather than guessing where to cut.
  if (records.length === 0) return [content];

  const parts: string[] = [];
  let current = '';

  for (const record of records) {
    // Start a new part when this record would overflow the current one. A
    // record larger than the cap on its own still goes out whole: silently
    // truncating a member's post is worse than one oversized call.
    if (current && (header.length + current.length + record.length) > maxChars) {
      parts.push(header + current);
      current = '';
    }
    current += record;
  }
  if (current) parts.push(header + current);

  return parts;
}
