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

// Which pass is the injected runner currently serving?
//
// Manifest length is NOT a safe discriminator — a single chunk of 12 and the
// synthesis pass over 12 subscriptions look identical by size. The run mode
// installed into CLAUDE.md is the real signal, and checking it here also
// asserts that installRunMode actually wrote what it claims.
function isSynthesisPass(): boolean {
  const claude = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf-8');
  return claude.includes('THIS RUN: HIGHLIGHTS ONLY');
}

function isSectionsPass(): boolean {
  const claude = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf-8');
  return claude.includes('THIS RUN: SECTIONS ONLY');
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
        if (isSynthesisPass()) return res(HL);
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
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (isSynthesisPass()) return res(HL);
        // Chunk 1 fails at EVERY size, so escalation cannot rescue it.
        // (Keyed on content rather than call count: splitting changes the
        // call sequence, and a call-index fixture would silently stop
        // testing what it claims to.)
        if (m.every((e) => Number(e.title.split(' ')[1]) < 12)) {
          return res('the model rambled instead of rendering');
        }
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
    const out = await runChunkedDigest('pi', chunks, workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (isSynthesisPass()) return res(HL);
        // Chunk 1 throws at every size — escalation tries smaller and still
        // cannot get through, which is the unreachable-model case.
        if (m.every((e) => Number(e.title.split(' ')[1]) < 12)) throw new Error('model unreachable');
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
        if (isSynthesisPass()) throw new Error('synthesis died');
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
        if (isSynthesisPass()) {
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
        if (isSynthesisPass()) return res(HL);
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

  // ============================================================
  // SPLIT-ON-FAILURE ESCALATION
  // ============================================================
  //
  // Degeneration is driven by how much the model is handed at once, so a
  // group that fails is worth retrying SMALLER before giving up on it.
  // Runtime is not a constraint here (the digest runs at 03:00 unattended)
  // and the extra passes are only paid on the nights something goes wrong.

  // ---- 9. a group that fails whole succeeds when halved ----
  {
    const calls: number[] = [];
    const out = await runChunkedDigest('pi', [all.slice(0, 12)], workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (isSynthesisPass()) return res(HL);
        calls.push(m.length);
        // Fails at 12, fine at 6.
        if (m.length > 6) return res('model rambled instead of rendering');
        return res(sectionsFor(m));
      });

    assert.equal(out.status, undefined, 'a group recovered by splitting must not be partial');
    assert.equal(out.skipped, undefined, 'nothing is skipped when a split succeeds');
    assert.equal((out.body.match(/^### \[/gm) ?? []).length, 12,
      'every subscription is rendered by the halves');

    // 12 twice (initial + its retry), then 6 and 6.
    assert.deepEqual(calls, [12, 12, 6, 6],
      'the whole group is tried (with its retry) before being halved');

    // Order must survive the split.
    const order = [...out.body.matchAll(/^### \[(.+?)\]/gm)].map((m) => m[1]);
    assert.deepEqual(order, all.slice(0, 12).map((e) => e.title),
      'splitting must not reorder subscriptions');
  }

  // ---- 10. escalation recurses: 12 -> 6 -> 3 ----
  {
    const sizes: number[] = [];
    const out = await runChunkedDigest('pi', [all.slice(0, 12)], workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        if (isSynthesisPass()) return res(HL);
        sizes.push(m.length);
        if (m.length > 3) return res('still too much');
        return res(sectionsFor(m));
      });

    assert.equal(out.skipped, undefined, 'a second split level must still recover everything');
    assert.equal((out.body.match(/^### \[/gm) ?? []).length, 12, 'all 12 recovered at depth 2');
    assert.ok(sizes.includes(3), 'the escalation reached groups of 3');
  }

  // ---- 11. escalation is BOUNDED — a hopeless group is skipped, not looped ----
  //
  // If the model is broken rather than overloaded, splitting cannot help. The
  // depth cap stops a bad night burning hours of pointless passes.
  {
    let calls = 0;
    const out = await runChunkedDigest('pi', [all.slice(0, 12)], workspace, 'interests', 'm',
      async () => { calls += 1; return res('never renders anything'); });

    assert.equal(out.status, 'invalid', 'nothing rendered anywhere means invalid');
    assert.equal(out.skipped?.length, 12, 'the whole group is reported as skipped');
    assert.ok(calls <= 16,
      `escalation must stay bounded; the depth cap allows at most 16 passes, saw ${calls}`);
    assert.ok(calls > 2, 'it must actually have tried splitting, not given up at the top');
  }

  // ---- 12. a partial recovery reports only what was really lost ----
  //
  // The half that renders must ship; only the half that never does is skipped,
  // and it is what makes the caller withhold notice-clearing.
  {
    const out = await runChunkedDigest('pi', [all.slice(0, 12)], workspace, 'interests', 'm',
      async (mp) => {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as ManifestEntry[];
        // Only groups drawn entirely from the first half (0..5) ever fail, so
        // escalation rescues 6 of the 12 and loses the rest — the partial case.
        if (m.every((e) => Number(e.title.split(' ')[1]) < 6)) return res('rambled');
        if (isSynthesisPass()) return res(HL);
        if (m.length === 12) return res('rambled');   // the whole group fails
        return res(sectionsFor(m));
      });

    assert.equal(out.status, 'partial');
    assert.ok(out.skipped!.length < 12,
      `only the failing part is lost, not the whole group (lost ${out.skipped!.length})`);
    assert.ok(out.body.includes('Subscription 11'), 'the healthy half still ships');
    assert.ok(!out.body.includes('Subscription 0'), 'the failing part contributes nothing');
  }

  fs.rmSync(workspace, { recursive: true, force: true });
  console.log('agent.chunked.test.ts: all assertions passed ✓');
}

tests().catch((err) => { console.error(err); process.exit(1); });
