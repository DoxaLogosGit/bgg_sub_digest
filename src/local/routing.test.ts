// ============================================================
// local/routing.test.ts — local first, escalate only what fails
// ============================================================
//
// Standalone. Run: npx tsx src/local/routing.test.ts
//
// WHAT THIS GUARDS: on 2026-09-11 the pipeline exhausted the monthly quota on
// both providers in a day. Escalation is per SUBSCRIPTION — one stubborn
// subscription costs one metered call, not a night's worth. An unconditional
// fallback would have spent 50.

import assert from 'node:assert/strict';
import { renderLocalFirst } from './render';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const interests: InterestsConfig = { priorityTitles: [], trackedGames: [], keywords: [], notes: '' };

function entry(i: number): ManifestEntry {
  return {
    subscriptionId: i, type: 'thread', title: `Sub ${i}`,
    url: `https://boardgamegeek.com/thread/${i}`, filePath: `/tmp/t${i}.md`,
    itemCount: 1, unreadCount: 1, notificationDate: null,
  };
}
const GOOD = '**Summary:** A genuine discussion took place with several detailed replies.\n\n**New Activity:**\n- alice — said a thing.';

const entries = [entry(1), entry(2), entry(3)];
const contents = new Map(entries.map((e) =>
  [e.filePath, `=== Thread: ${e.title} ===\n\n[Post by alice on 9/1/2026]\nbody\n`]));

async function main() {
  // ---- all local: no cloud call is ever made ----
  {
    let local = 0, cloud = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { local += 1; return GOOD; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(local, 3, 'one local call per subscription');
    assert.equal(cloud, 0, 'a healthy night never spends a metered token');
    assert.equal(r.skipped.length, 0);
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 3);
  }

  // ---- a defective local render is RETRIED locally before escalating ----
  //
  // Local calls are unmetered, so a retry is near-free insurance against a
  // one-off bad generation and keeps a transient wobble off the metered tier.
  {
    let attempts = 0, cloud = 0;
    const r = await renderLocalFirst({
      entries: [entry(1)], contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { attempts += 1; return attempts === 1 ? '' : GOOD; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(attempts, 2, 'a defective local render is retried locally once');
    assert.equal(cloud, 0, 'and a successful retry never reaches the metered tier');
    assert.equal(r.skipped.length, 0);
  }

  // ---- the retry is not infinite ----
  {
    let attempts = 0, cloud = 0;
    await renderLocalFirst({
      entries: [entry(1)], contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async () => { attempts += 1; return ''; },
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(attempts, 2, 'exactly one retry, then escalate');
    assert.equal(cloud, 1);
  }

  // ---- one bad subscription escalates ALONE ----
  {
    let cloud = 0;
    const escalated: string[] = [];
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 2 ? '' : GOOD),
      escalateGroup: async (group) => {
        cloud += 1;
        escalated.push(...group.map((g) => g.title));
        return `### [${group[0].title}](${group[0].url})\n\n**Summary:** Cloud wrote this one after local failed.\n\n**New Activity:**\n- bob — said a thing.`;
      },
    });
    assert.equal(cloud, 1, 'exactly one metered call, for the one failing subscription');
    assert.deepEqual(escalated, ['Sub 2'], 'and only that subscription was escalated');
    assert.equal(r.skipped.length, 0, 'the escalation rescued it');
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 3, 'all three sections ship');
  }

  // ---- --local-only never escalates, and records the loss ----
  {
    let cloud = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: false,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 2 ? '' : GOOD),
      escalateGroup: async () => { cloud += 1; return null; },
    });
    assert.equal(cloud, 0, '--local-only must never spend a metered token');
    assert.deepEqual(r.skipped.map((s) => s.title), ['Sub 2'],
      'the failing subscription is recorded as skipped so notices are not cleared');
    assert.equal((r.sections.match(/^### \[/gm) ?? []).length, 2);
  }

  // ---- cloud also failing means the subscription is skipped ----
  {
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: true,
      askLocal: async (_i, _w, e) => (e.subscriptionId === 3 ? '' : GOOD),
      escalateGroup: async () => null,
    });
    assert.deepEqual(r.skipped.map((s) => s.title), ['Sub 3']);
    assert.ok(r.skipped[0].reason.length > 0, 'the reason is recorded for the morning');
  }

  // ---- the local budget halts the run ----
  {
    let local = 0;
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: false,
      maxLocalCalls: 2,
      askLocal: async () => { local += 1; return GOOD; },
      escalateGroup: async () => null,
    });
    assert.ok(local <= 2, `the local budget must be enforced, saw ${local}`);
    assert.ok(r.skipped.length > 0, 'subscriptions past the budget are recorded as lost');
    assert.match(r.skipped[0].reason, /budget/i);
  }

  // ---- ranked order is preserved in the output ----
  {
    const r = await renderLocalFirst({
      entries, contents, interests, maxInputChars: 100_000, escalates: false,
      askLocal: async () => GOOD,
      escalateGroup: async () => null,
    });
    assert.deepEqual([...r.sections.matchAll(/^### \[(.+?)\]/gm)].map((m) => m[1]),
      ['Sub 1', 'Sub 2', 'Sub 3'], 'sections keep the ranked order they arrived in');
  }

  console.log('routing.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
