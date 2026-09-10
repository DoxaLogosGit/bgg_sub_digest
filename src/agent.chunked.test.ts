// ============================================================
// agent.chunked.test.ts — the chunked digest orchestrator
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/agent.chunked.test.ts
//
// The model runner is injected, so every path here is exercised without a
// live model — including the failure paths, which are the ones that decide
// whether a bad night costs data.

import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runChunkedDigest, extractHighlightsBlock, stripHighlightsBlock } from './agent';
import type { ManifestEntry, DigestResult } from './agent';

// ---- workspace ------------------------------------------------
// runChunkedDigest writes manifests and SECTIONS.md, so it needs a real dir.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bgg-chunk-test-'));

function entry(i: number): ManifestEntry {
  return {
    subscriptionId: 1000 + i,
    type: 'thread',
    title: `Subscription ${i}`,
    url: `https://boardgamegeek.com/thread/${1000 + i}`,
    filePath: `/tmp/thread-${1000 + i}.md`,
    itemCount: 1,
    unreadCount: 1,
    notificationDate: null,
  };
}

function sectionsFor(entries: ManifestEntry[]): string {
  return entries.map((e) =>
    `### [${e.title}](${e.url})\n\n**Summary:** Real discussion of ${e.title}.\n\n` +
    `**New Activity:**\n- someone posted about ${e.title}.\n\n**Topics Mentioned:** solo\n`,
  ).join('\n');
}

function res(body: string, over: Partial<DigestResult> = {}): DigestResult {
  return { body, inputTokens: 10, outputTokens: 5, costUsd: 0, durationMs: 1, ...over };
}

const HL = '## ⭐ Highlights\n\n- ⭐ Spirit Island — a rules question in two chunks.';

// Read back the chunk manifests the orchestrator wrote, so we can assert on
// what each pass was actually handed.
function manifestSeen(): ManifestEntry[] {
  return JSON.parse(fs.readFileSync(path.join(workspace, 'manifest.json'), 'utf-8'));
}

async function tests() {
  const all = Array.from({ length: 25 }, (_, i) => entry(i));
  const chunks = [all.slice(0, 12), all.slice(12, 24), all.slice(24)];

  // ---- 1. happy path: every chunk renders, synthesis adds Highlights ----
  {
    const seen: number[] = [];
    let call = 0;
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        call += 1;
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        // The 4th call is the synthesis pass.
        if (call === chunks.length + 1) return res(HL);
        seen.push(m.length);
        return res(sectionsFor(m));
      });

    assert.deepEqual(seen, [12, 12, 1], 'each chunk pass gets exactly its own slice');
    assert.equal(call, 4, '3 chunk passes + 1 synthesis pass');
    assert.equal(out.status, undefined, 'a fully successful chunked run is shippable');
    assert.equal(out.completedCount, 25, 'all 25 sections counted');
    assert.equal(out.totalCount, 25);

    // Highlights first, then every section, in ranked order.
    assert.ok(out.body.startsWith('## ⭐ Highlights'), 'Highlights leads the assembled body');
    const order = [...out.body.matchAll(/^### \[(.+?)\]/gm)].map((m) => m[1]);
    assert.equal(order.length, 25, 'every section present exactly once');
    assert.deepEqual(order, all.map((e) => e.title),
      'chunk order must preserve the ranked order across boundaries');

    // Token usage is summed across every pass, not just the last.
    assert.equal(out.inputTokens, 40, '4 passes x 10 input tokens');
  }

  // ---- 2. a chunk that stays defective is SKIPPED, not shipped silently ----
  //
  // This is the 2026-09-10 lesson: content that never got summarised must make
  // the run refuse to clear BGG notices. skipped[] is what drives that.
  {
    let call = 0;
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        call += 1;
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (call === 1 || call === 2) return res('### [Only one](https://x)\n\n**Topics Mentioned:** none\n');
        if (m.length === 25) return res(HL);          // synthesis
        return res(sectionsFor(m));
      });

    assert.equal(out.status, 'partial', 'a lost chunk makes the run partial');
    assert.ok(out.skipped && out.skipped.length === 12,
      `the failed chunk's 12 subscriptions are all recorded as skipped, got ${out.skipped?.length}`);
    assert.match(out.skipped![0].reason, /defective after retry/);
    assert.ok(!out.body.includes('Subscription 0'), 'the failed chunk contributes no sections');
    assert.ok(out.body.includes('Subscription 12'), 'the healthy chunks still ship');
  }

  // ---- 3. a chunk that THROWS is contained ----
  {
    let call = 0;
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        call += 1;
        if (call === 1) throw new Error('model unreachable');
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (m.length === 25) return res(HL);
        return res(sectionsFor(m));
      });

    assert.equal(out.status, 'partial', 'a thrown chunk must not abort the whole digest');
    assert.equal(out.skipped?.length, 12);
    assert.match(out.skipped![0].reason, /model unreachable/);
    assert.ok(out.body.includes('Subscription 12'), 'later chunks still run after one throws');
  }

  // ---- 4. a failed synthesis pass costs Highlights, never the sections ----
  {
    let call = 0;
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        call += 1;
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (m.length === 25) throw new Error('synthesis died');
        return res(sectionsFor(m));
      });

    assert.equal(out.status, undefined, 'no subscription was lost, so the run is not partial');
    assert.equal(out.completedCount, 25, 'every section survived');
    assert.ok(!out.body.includes('Highlights'), 'no Highlights block when synthesis fails');
    assert.ok(out.body.includes('Subscription 24'), 'the sections are shipped regardless');
  }

  // ---- 5. every chunk failing yields invalid, so nothing is cleared ----
  {
    // A body with NO sections at all — the third chunk holds a single entry,
    // so a one-section body would legitimately satisfy it and the run would
    // (correctly) come back partial rather than invalid.
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async () => res('The model wrote prose instead of a digest.'));

    assert.equal(out.status, 'invalid', 'a total failure must be invalid, not partial');
    assert.equal(out.body, '', 'no body to ship');
    assert.equal(out.completedCount, 0);
    assert.equal(out.skipped?.length, 25, 'every subscription is recorded as lost');
  }

  // ---- 6. the synthesis pass reads SECTIONS.md, and it holds every section ----
  {
    await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (m.length === 25) {
          const sections = fs.readFileSync(path.join(workspace, 'SECTIONS.md'), 'utf-8');
          assert.equal((sections.match(/^### \[/gm) ?? []).length, 25,
            'SECTIONS.md must contain every rendered section for the synthesis pass');
          assert.ok(!sections.includes('Highlights'), 'SECTIONS.md carries no Highlights block');
          return res(HL);
        }
        return res(sectionsFor(m));
      });
  }

  // ---- 7. a chunk that writes Highlights anyway has it stripped ----
  //
  // Chunks are instructed not to, but models disobey. Several competing blocks
  // would confuse liftHighlightsToTop, which keeps the LAST one it sees — a
  // single chunk's partial view masquerading as the whole-digest summary.
  {
    let call = 0;
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        call += 1;
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (m.length === 25) return res(HL);
        return res(sectionsFor(m) + '\n\n## ⭐ Highlights\n\n- ⭐ only my chunk\n');
      });

    assert.equal((out.body.match(/## ⭐ Highlights/g) ?? []).length, 1,
      'exactly one Highlights block survives');
    assert.ok(!out.body.includes('only my chunk'),
      "a chunk's own Highlights must be stripped, not shipped");
    assert.equal((out.body.match(/^### \[/gm) ?? []).length, 25,
      'stripping Highlights must not take sections with it');
  }

  // ---- 8. the helpers in isolation ----
  {
    assert.equal(extractHighlightsBlock('no block here'), '');
    assert.equal(extractHighlightsBlock('## ⭐ Highlights\n\n- a').trim(), '## ⭐ Highlights\n\n- a');
    // Without the star, too — models drop it.
    assert.match(extractHighlightsBlock('intro\n## Highlights\n\n- a'), /^## Highlights/);

    const mixed = '### [A](u)\n\ntext\n\n## ⭐ Highlights\n\n- x\n\n### [B](u)\n\nmore\n';
    const stripped = stripHighlightsBlock(mixed);
    assert.ok(!stripped.includes('Highlights'), 'the block is removed');
    assert.ok(stripped.includes('### [A]') && stripped.includes('### [B]'),
      'sections on both sides of the block survive');
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log('agent.chunked.test.ts: all assertions passed ✓');
}

tests().catch((err) => { console.error(err); process.exit(1); });
