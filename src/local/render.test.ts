// ============================================================
// local/render.test.ts — one subscription, rendered locally
// ============================================================
//
// Standalone. Run: npx tsx src/local/render.test.ts
//
// The model call is injected, so every path here runs without a model —
// including the failure paths, which decide whether a bad night costs data.

import assert from 'node:assert/strict';
import { listRecords, renderSubscriptionLocally } from './render';
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
    assert.ok(!/not summarised/.test(r.section!), 'a part that recovers on retry is summarised normally');
  }

  // ---- a part that stays empty is LISTED, never dropped ----
  //
  // 2026-09-13: 5 of ~8 SGOYT parts timed out, the survivors made the section
  // valid, and ~25 of 50 items vanished while the run reported complete and
  // cleared its notices. A dead part must be retried on its own, and if it
  // never answers its items must still appear, with links.
  {
    const perPart = new Map<string, number>();
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (input, wantSummary) => {
        if (wantSummary) return '**Summary:** Members posted several solo sessions with scores and reviews.';
        perPart.set(input, (perPart.get(input) ?? 0) + 1);
        return input.includes('member1 posted') ? '' : BULLETS_ONLY;
      },
    });
    const deadPart = [...perPart.keys()].find((k) => k.includes('member1 posted'))!;
    assert.equal(perPart.get(deadPart), 3, 'the dead part is retried on its own');
    assert.equal(r.defect, null);
    assert.match(r.section!, /^- member1 — \[Spirit Island\]\(https:\/\/x\/#item1\) \(not summarised\)$/m,
      'its item is listed in code, with a link');
    assert.match(r.section!, /could not be summarised and (is|are) listed by title only/,
      'and the summary says part of the section is a bare listing');
    assert.ok(!/listed in full/.test(r.section!), 'never claims completeness');
  }

  // ---- listRecords reads thread posts too ----
  {
    const thread = '=== Thread: X ===\n\n[Post by zolmikthiat on 9/12/2026]\n' +
      'Subject: Re: Mage Knight?\nLink: https://boardgamegeek.com/thread/1?article=2\nBody.\n\n';
    assert.deepEqual(listRecords(thread),
      ['- zolmikthiat — [Re: Mage Knight?](https://boardgamegeek.com/thread/1?article=2) (not summarised)']);
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

  // ---- a STUB costs no model call at all ----
  //
  // 33 of the 50 subscriptions in a real workspace are stubs: files whose
  // entire content is "New activity on a BGG <type> you subscribe to." There
  // is nothing to summarise. BGG-DATA-GUIDE.md section 3 exists to say DO NOT
  // INFER CONTENT for these, and handing one to a model invites exactly that
  // invention — several returned empty on 2026-09-12, and the rest are
  // unverifiable.
  {
    let calls = 0;
    const stub = '# Custom Models\n\nNew activity on a BGG unknown you subscribe to.\n\n' +
                 '**Context:** The Lord of the Rings: Fate of the Fellowship\n\n' +
                 '**Link:** https://boardgamegeek.com/thing/1\n';
    const r = await renderSubscriptionLocally({
      entry, content: stub, interests, maxInputChars: 100_000,
      askProse: async () => { calls += 1; return 'INVENTED CONTENT'; },
    });
    assert.equal(calls, 0, 'a stub must never reach the model');
    assert.equal(r.defect, null, 'and still produces a valid section');
    assert.ok(!r.section!.includes('INVENTED'), 'nothing is invented');
    assert.match(r.section!, /does not expose|not retrievable|nothing to summarise/i,
      'the section says plainly that there is no content');
    assert.ok(r.section!.includes(entry.title),
      'the stub summary names the subscription — 32 identical summaries in a real ' +
      'workspace drove isVacuousDigest to 0.326 against its 0.30 floor');
    assert.equal(r.calls, 0);
  }

  // ---- a FAILED fetch is not described as "BGG does not expose" ----
  //
  // 2026-09-13: "SGOYT made me buy this!" 202-timed-out and read as if BGG
  // never offered its content. It is temporary and its notice is kept.
  {
    const stub = '# SGOYT made me buy this!\n\nNew activity on a BGG geeklist you subscribe to ' +
                 '(temporary fetch failure — will retry next run).\n\n**Link:** https://boardgamegeek.com/geeklist/166714\n';
    const r = await renderSubscriptionLocally({
      entry, content: stub, interests, maxInputChars: 100_000,
      askProse: async () => { throw new Error('a stub must not reach the model'); },
    });
    assert.equal(r.defect, null);
    assert.ok(!/does not expose/.test(r.section!), 'not blamed on the API');
    assert.match(r.section!, /temporary API failure.*next run will try again/);
  }

  // ---- the model may omit the **Summary:** marker; code adds it ----
  //
  // Observed 2026-09-12 on the SGOYT split path: the summary call returned a
  // perfectly good sentence with no "**Summary:**" prefix, and the section was
  // rejected for "no Summary line". The marker is STRUCTURE, and this module's
  // whole premise is that code writes structure and the model writes prose.
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () =>
        'Members posted six solo sessions this week with scores and short reviews.\n\n' +
        '**New Activity:**\n- member1 — played Spirit Island and won at level 3.',
    });
    assert.equal(r.defect, null, 'a missing Summary marker is repaired, not rejected');
    assert.match(r.section!, /^\*\*Summary:\*\* Members posted six solo sessions/m);
  }

  // ---- a doubled marker is not produced ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 100_000,
      askProse: async () => GOOD_PROSE,
    });
    assert.equal((r.section!.match(/\*\*Summary:\*\*/g) ?? []).length, 1,
      'exactly one Summary marker');
  }

  // ---- the same repair applies on the SPLIT path ----
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) => (wantSummary
        ? 'Six members posted solo sessions with scores and short reviews of each game.'
        : BULLETS_ONLY),
    });
    assert.equal(r.defect, null, 'the split path repairs the marker too');
    assert.match(r.section!, /^\*\*Summary:\*\* Six members posted/m);
    assert.equal((r.section!.match(/\*\*New Activity:\*\*/g) ?? []).length, 1,
      'exactly one New Activity heading');
  }

  // ---- an empty SUMMARY call does not lose a split subscription ----
  //
  // Observed 2026-09-12: SGOYT September (61KB, 8 parts) produced all its
  // bullets and was then thrown away because the final summary call returned
  // nothing. Losing 50 items of the reader's most-valued subscription to one
  // flaky call is absurd when the bullets are already in hand — code can state
  // what they contain without inventing anything.
  {
    const r = await renderSubscriptionLocally({
      entry, content, interests, maxInputChars: 700,
      askProse: async (_i, wantSummary) => (wantSummary ? '' : BULLETS_ONLY),
    });
    assert.equal(r.defect, null, 'the subscription survives an empty summary call');
    assert.ok(r.section!.includes('- member1'), 'the bullets are kept');
    assert.match(r.section!, /^\*\*Summary:\*\* .{40,}/m,
      'and a factual summary is derived from them in code');
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
