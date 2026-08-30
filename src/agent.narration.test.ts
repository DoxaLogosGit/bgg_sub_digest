// ============================================================
// agent.narration.test.ts — strip mid-body / trailing model narration
// ============================================================
//
// Standalone test (the project has no test framework yet). Run it with:
//   npx tsx src/agent.narration.test.ts
//
// WHAT IT GUARDS (2026-08-30, pi + nemotron-3-super:cloud, real cron output):
//   stripPreamble() only removes narration BEFORE the first section. This
//   model narrated in three other places that survived the pipeline and
//   landed in the reader's email:
//
//     1. BETWEEN sections  — "Now, next section: Priority Threads: ..."
//                            "Now, Tracked Games section. We'll start with ..."
//     2. AFTER the last section, before the Highlights header — a ~50-line
//        planning block ("Let's list the tracked games ...", "We'll write:").
//     3. AFTER the Highlights bullets — "Now, we have the entire digest.",
//        "We'll output it all at once.", "Let's put it together."
//
//   liftHighlightsToTop() then made it worse rather than better: it slices
//   from the Highlights header to the END OF BODY and moves that to the top,
//   so (3) was relocated to just under the Highlights bullets while (2) was
//   left stranded at the very bottom of the digest. The reader saw clutter at
//   BOTH ends. The giveaway in the real digest: its final line before the
//   footer was "We'll write:" — the sentence that had immediately preceded
//   the Highlights header in the model's raw output.
//
// WHY NOT PROMPT-ONLY: CLAUDE.md already says "Do not write planning
// sentences" and this model ignored it, exactly as minimax-m3 ignored it in
// the 2026-06-04 incident that motivated stripPreamble. Post-hoc stripping is
// the only thing that actually holds.
//
// THE STRUCTURAL RULE (deliberately not keyword matching — see stripPreamble's
// anchor approach, which this mirrors):
//   - Every real section ends with a "**Topics Mentioned:**" line, per
//     templates/section.md. Inside a section, anything AFTER that line is
//     narration and gets dropped.
//   - The Highlights block is its header plus contiguous "-" bullets.
//     Anything after the bullets is narration and gets dropped.
//   - Safety valve: a section with no "**Topics Mentioned:**" line is left
//     completely untouched rather than guessed at.

import assert from 'node:assert/strict';
import { stripBlockNarration, postProcessDigestBody } from './agent';

// ---- Fixture ----
// Mirrors the SHAPE of the real 2026-08-30 output, in the model's original
// (pre-lift) order: sections first, then the Highlights block last. The
// narration strings are taken verbatim from that digest so the test reflects
// ground truth rather than an invented guess.
const RAW = `### [Solitaire Games on Your Table -- August 2026](https://boardgamegeek.com/geeklist/381969/solitaire-games-on-your-table-august-2026)

**Summary:** The August solo geeklist saw 50 new items.

**New Activity:**
- ⭐ B2TB — Track & Field Solo Meet, scored 55. [Link](https://boardgamegeek.com/geeklist/381969#item13095697)

**Topics Mentioned:** solo, solitaire, expansion

---

Now, next section: Priority Threads: thread-3745874 (August 2026 Culling)

### [August 2026 Culling](https://boardgamegeek.com/thread/3745874/august-2026-culling)
*Parent: 1 Player guild*

**Summary:** A culling thread.

**New Activity:**
- Someone culled a game. [Link](https://boardgamegeek.com/thread/3745874?article=1)

**Topics Mentioned:** none

---

Now, after all subscription sections, we need to write the Highlights block LAST, following the template.

We'll look across all sections for mentions of tracked games and keywords.

Let's list the tracked games that appeared in multiple subscriptions:

1. Star Trek: Captain's Chair: appeared in geeklist-381969 (two items). We can create a bullet: "Star Trek: Captain's Chair — Featured in multiple solo game reports."

Now, major themes:

We should avoid too many bullets; the highlights should be concise.

Let's craft the Highlights block.

We'll write:

## ⭐ Highlights

- ⭐ Star Trek: Captain's Chair — Featured in multiple solo game reports.
- ⭐ Solo / solitaire — Dominated the geeklist with 50+ plays.

Now, we need to ensure we don't duplicate. For example, the solo bullet covers the geeklist.

Now, we have the entire digest.

We'll output it all at once.

Let's put it together.`;

// ---- 1. narration between sections is dropped ----
{
  const out = stripBlockNarration(RAW);
  assert.ok(
    !out.includes('Now, next section: Priority Threads'),
    'inter-section narration must be stripped',
  );
  assert.ok(
    !out.includes('Now, after all subscription sections'),
    'planning block before Highlights must be stripped',
  );
  assert.ok(
    !out.includes("Let's craft the Highlights block"),
    'planning narration must be stripped',
  );
  assert.ok(!out.includes("We'll write:"), '"We\'ll write:" must be stripped');
}

// ---- 2. narration after the Highlights bullets is dropped ----
{
  const out = stripBlockNarration(RAW);
  assert.ok(!out.includes('We\'ll output it all at once'), 'post-Highlights narration must go');
  assert.ok(!out.includes("Let's put it together"), 'post-Highlights narration must go');
  assert.ok(
    !out.includes("Now, we need to ensure we don't duplicate"),
    'post-Highlights narration must go',
  );
}

// ---- 3. every piece of REAL content survives ----
{
  const out = stripBlockNarration(RAW);
  for (const keep of [
    '### [Solitaire Games on Your Table -- August 2026]',
    '### [August 2026 Culling]',
    '*Parent: 1 Player guild*',
    '**Summary:** The August solo geeklist saw 50 new items.',
    'Track & Field Solo Meet, scored 55',
    '**Topics Mentioned:** solo, solitaire, expansion',
    '**Topics Mentioned:** none',
    '## ⭐ Highlights',
    '- ⭐ Star Trek: Captain\'s Chair — Featured in multiple solo game reports.',
    '- ⭐ Solo / solitaire — Dominated the geeklist with 50+ plays.',
  ]) {
    assert.ok(out.includes(keep), `real content must survive: ${keep}`);
  }
  // Both sections still present exactly once.
  assert.equal((out.match(/^### \[/gm) ?? []).length, 2, 'both sections kept');
}

// ---- 4. safety valve: a section with no Topics Mentioned is untouched ----
// We would rather keep a little narration than silently delete real content
// from a malformed section.
{
  const malformed = `### [Some Thread](https://boardgamegeek.com/thread/1/x)

**Summary:** Something happened and the model never emitted a Topics line.

Some trailing prose that we cannot safely classify.`;
  const out = stripBlockNarration(malformed);
  assert.equal(out.trim(), malformed.trim(), 'no Topics Mentioned => leave section alone');
}

// ---- 5. a clean digest is unchanged (no false positives) ----
{
  const clean = `### [A Thread](https://boardgamegeek.com/thread/1/a)

**Summary:** Clean.

**New Activity:**
- Something. [Link](https://boardgamegeek.com/thread/1?article=2)

**Topics Mentioned:** none

## ⭐ Highlights

- ⭐ A Thread — happened.`;
  assert.equal(stripBlockNarration(clean).trim(), clean.trim(), 'clean digest must be untouched');
}

// ---- 6. end-to-end through the real pipeline ----
// The regression the reader actually saw: after postProcessDigestBody, the
// digest must not END with planning narration, and must not carry narration
// directly beneath the lifted Highlights bullets.
{
  const out = postProcessDigestBody(RAW);

  // Highlights must have been lifted to the top.
  assert.ok(out.trimStart().startsWith('## ⭐ Highlights'), 'Highlights lifted to top');

  // The specific symptom: final line was "We'll write:".
  assert.ok(!/We'll write:\s*$/.test(out.trim()), 'digest must not end with planning narration');

  for (const banned of [
    'Now, next section',
    'Now, after all subscription sections',
    "Let's craft the Highlights block",
    "We'll output it all at once",
    "Let's put it together",
  ]) {
    assert.ok(!out.includes(banned), `pipeline must remove narration: ${banned}`);
  }

  // And the real content is still all there.
  assert.equal((out.match(/^### \[/gm) ?? []).length, 2, 'both sections survive the pipeline');
  assert.ok(out.includes('**Topics Mentioned:** solo, solitaire, expansion'));
}

console.log('✓ agent.narration.test.ts — all assertions passed');
