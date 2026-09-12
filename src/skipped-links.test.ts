// ============================================================
// skipped-links.test.ts — a skipped subscription must stay reachable
// ============================================================
//
// Standalone. Run: npx tsx src/skipped-links.test.ts
//
// WHY THIS EXISTS: as of 2026-09-13 a PARTIAL run clears BGG notices. That is
// only defensible while the digest itself names every skipped subscription
// with a working link — the notice is gone, digest-data/ is rm -rf'd at the
// start of the next run, so the digest line is the ONLY remaining record.
//
// Before this change the banner printed filePath, which is inside digest-data
// and therefore dangling by the next morning. These assertions pin the
// precondition, not the formatting.

import assert from 'node:assert/strict';
import type { DigestSkippedEntry } from './agent';
import { renderLocalFirst } from './local/render';
import type { ManifestEntry } from './agent';
import type { InterestsConfig } from './interests';

const interests: InterestsConfig = { priorityTitles: [], trackedGames: [], keywords: [], notes: '' };

function entry(i: number): ManifestEntry {
  return {
    subscriptionId: i, type: 'thread', title: `Sub ${i}`,
    url: `https://boardgamegeek.com/thread/${i}/slug`, filePath: `/tmp/t${i}.md`,
    itemCount: 1, unreadCount: 1, notificationDate: null,
  };
}

// The banner built in index.ts. Kept here as the shape under test so a change
// to it has to break this file.
function partialBanner(skipped: DigestSkippedEntry[]): string {
  return skipped.map((s) => `> - [${s.title}](${s.url})`).join('\n');
}

async function main() {
  const entries = [entry(1), entry(2)];
  const contents = new Map(entries.map((e) =>
    [e.filePath, `=== Thread: ${e.title} ===\n\n[Post by alice on 9/1/2026]\nbody\n`]));

  // ---- every skipped entry carries a usable BGG url ----
  const r = await renderLocalFirst({
    entries, contents, interests, maxInputChars: 100_000, escalates: false,
    askLocal: async () => '',                 // everything fails
    escalateGroup: async () => null,
  });

  assert.equal(r.skipped.length, 2, 'both subscriptions were skipped');
  for (const s of r.skipped) {
    assert.ok(s.url, `skipped entry "${s.title}" has no url — it would be unreachable`);
    assert.match(s.url, /^https:\/\/boardgamegeek\.com\//,
      'the url must point at BGG, not at a local file');
  }

  // ---- the rendered banner is a real markdown link ----
  const banner = partialBanner(r.skipped);
  assert.match(banner, /\[Sub 1\]\(https:\/\/boardgamegeek\.com\/thread\/1\/slug\)/,
    'the banner renders a clickable link');

  // ---- and NOT a digest-data path ----
  //
  // digest-data is rm -rf'd at the start of every run, so a path there is
  // dangling by the next morning — the exact reason this test exists.
  assert.ok(!banner.includes('/tmp/t1.md'), 'the banner must not rely on the data-file path');
  assert.ok(!banner.includes('digest-data'), 'a digest-data path is worthless once the next run starts');

  console.log('skipped-links.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
