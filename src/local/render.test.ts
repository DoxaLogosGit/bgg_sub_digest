// ============================================================
// local/render.test.ts — one subscription, rendered locally
// ============================================================
//
// Standalone. Run: npx tsx src/local/render.test.ts
//
// The model call is injected, so every path here runs without a model —
// including the failure paths, which decide whether a bad night costs data.

import assert from 'node:assert/strict';
import { renderSubscriptionLocally } from './render';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const interests: InterestsConfig = {
  priorityTitles: [], trackedGames: ['Spirit Island'], keywords: ['solo'], notes: '',
};

const entry: ManifestEntry = {
  subscriptionId: 1, type: 'geeklist', title: 'SGOYT September',
  url: 'https://boardgamegeek.com/geeklist/383712',
  filePath: '/tmp/geeklist-383712.md',
  itemCount: 6, unreadCount: 6, notificationDate: null,
};

const header = '=== Geeklist: SGOYT September ===\n\n';
// Bodies mention "solo" because SGOYT items do, and because matchTopics reads
// the CONTENT rather than the title — a fixture without the keyword would test
// nothing.
const item = (n: number) =>
  `[Item by member${n} posted 9/1/2026] — Spirit Island\nLink: https://x/#item${n}\nA solo session. ${'body '.repeat(35)}\n\n`;
const content = header + [1, 2, 3, 4, 5, 6].map(item).join('');

const GOOD_PROSE =
  '**Summary:** Members posted six solo sessions with scores and short reviews of each game.\n\n' +
  '**New Activity:**\n- member1 — played Spirit Island and won at level 3.';
const BULLETS_ONLY = '**New Activity:**\n- member1 — played Spirit Island and won at level 3.';

async function main() {
  // ---- small input: ONE call, section assembled around the prose ----
  {
    let calls = 0;
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => { calls += 1; return GOOD_PROSE; },
    });
    assert.equal(calls, 1, 'content under the cap costs exactly one call');
    assert.equal(r.defect, null);
    assert.ok(r.section!.startsWith('### [SGOYT September](https://boardgamegeek.com/geeklist/383712)'),
      'the header comes from the manifest');
    assert.match(r.section!, /\*\*Topics Mentioned:\*\* Spirit Island, solo/,
      'topics are computed in code from the CONTENT, not asked of the model');
  }

  // ---- large input: split into parts, each asked for BULLETS ONLY ----
  //
  // Then one final call writes the Summary over the merged bullets. Asking
  // every part for its own Summary would produce several competing summaries
  // with no principled way to choose between them.
  {
    const asks: boolean[] = [];
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_input, wantSummary) => {
        asks.push(wantSummary);
        return wantSummary
          ? '**Summary:** Members posted six solo sessions with scores and short reviews.'
          : BULLETS_ONLY;
      },
    });

    assert.ok(asks.length > 2, `a split subscription makes several calls, saw ${asks.length}`);
    assert.equal(asks.filter((w) => w).length, 1, 'exactly one call asks for the Summary');
    assert.equal(asks[asks.length - 1], true, 'and it is the LAST call, over the merged bullets');
    assert.equal(r.defect, null);
    assert.equal((r.section!.match(/^- member1 /gm) ?? []).length, asks.length - 1,
      'every part contributes its bullets to one merged section');
  }

  // ---- a defective result is reported, not shipped ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => '**Summary:** New activity.\n\n**New Activity:**\n- See file for details',
    });
    assert.equal(r.section, null, 'a defective render yields no section');
    assert.ok(r.defect, 'and names the defect');
  }

  // ---- the model returning nothing at all is a defect, not a crash ----
  //
  // Measured 2026-09-11: above ~3K input tokens the local model returns an
  // empty string with no error. That is the single most likely failure here.
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => '',
    });
    assert.equal(r.section, null);
    assert.ok(r.defect && /empty/i.test(r.defect), `empty output must be named, got ${r.defect}`);
  }

  // ---- one empty PART does not lose the whole subscription ----
  //
  // The other parts still contribute their bullets; only a total loss fails.
  {
    let n = 0;
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) => {
        if (wantSummary) return '**Summary:** Members posted several solo sessions with scores and reviews.';
        n += 1;
        return n === 1 ? '' : BULLETS_ONLY;
      },
    });
    assert.equal(r.defect, null, 'one dead part does not sink the subscription');
    assert.ok(r.section!.includes('- member1'), 'surviving parts still contribute');
  }

  // ---- every part empty IS a defect ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) => (wantSummary ? '**Summary:** ' + 'x'.repeat(60) : ''),
    });
    assert.equal(r.section, null);
    assert.ok(r.defect && /bullet/i.test(r.defect), `got ${r.defect}`);
  }

  // ---- calls are counted so the caller can enforce a budget ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) =>
        (wantSummary ? '**Summary:** ' + 'x'.repeat(60) : BULLETS_ONLY),
    });
    assert.ok(r.calls >= 2, `calls are reported, saw ${r.calls}`);
  }

  console.log('render.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
