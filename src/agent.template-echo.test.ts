// ============================================================
// agent.template-echo.test.ts — unit tests for isTemplateEcho()
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/agent.template-echo.test.ts
//
// Guards the 2026-06-26 failure mode: the model echoed the unfilled template
// (copied the format examples out of digest-data/templates/*.md) and the
// pipeline emailed it AND cleared the BGG notices, losing the activity.
// isTemplateEcho must flag that output and pass a genuinely-filled digest.

import assert from 'node:assert/strict';
import {
  isTemplateEcho,
  isMissingHighlights,
  stripReasoningTags,
  generateGuardedDigest,
  type DigestResult,
} from './agent';

// A genuinely-filled digest — must NOT be flagged.
const good = `## ⭐ Highlights

- ⭐ **Marvel Champions** — New Jessica Jones and Luke Cage hero cards revealed.

### [1 Player Guild / SGOYT - 2026 Solitaire Goals](https://boardgamegeek.com/geeklist/370786)

**Summary:** The 1 Player Guild's annual SGOYT goals list sees new activity. Njps
posted updates on their 2026 solo play goals.

**New Activity:**
- ⭐ Njps logged Solo Fluxx and adjusted their target up to 100 plays.

**Topics Mentioned:** solo
`;

// The unfilled-template echo — copied straight from the template files.
const bad = `## ⭐ Highlights

- ⭐ <Tracked game> — <one-line summary of where it appeared and why it matters>

### [Shran Automated Command Card](https://boardgamegeek.com/thread/3728814)
*Parent: <parentName>* — only include this line if \`parentName\` is set in the manifest entry

**Summary:** 2–4 sentences on what's new and the overall tone.

**New Activity:**
- Bullet per notable item (max 8). Include author, brief description, and link where available. Mark items matching the reader's interests with ⭐.

**Topics Mentioned:** comma-separated list of matched interests, or "none"
`;

assert.equal(isTemplateEcho(good), false, 'a genuinely-filled digest must not be flagged');
assert.equal(isTemplateEcho(bad), true, 'the unfilled-template echo must be flagged');

// A digest that merely QUOTES one sentinel phrase in prose must not trip the
// guard (the >= 2 distinct-hit threshold protects against this).
const oneQuote = good + '\nSomeone joked the bot just prints "comma-separated list of matched interests" lol\n';
assert.equal(isTemplateEcho(oneQuote), false, 'a single incidental sentinel must not trip the guard');

// ---- isMissingHighlights: the 2026-07-02 failure mode ----
//
// minimax-m3 degenerated (re-rendered sections, leaked reasoning) and never
// emitted the "## ⭐ Highlights" block, yet the pipeline shipped it as
// status=complete AND cleared 42 notices. A digest with no Highlights header
// must be flagged.
const noHighlights = `### [Some Thread](https://boardgamegeek.com/thread/1)

**Summary:** Two new replies.

**New Activity:**
- somebody said a thing.

**Topics Mentioned:** solo
`;
assert.equal(isMissingHighlights(good), false, 'a digest WITH a Highlights header must not be flagged');
assert.equal(isMissingHighlights(noHighlights), true, 'a digest with no Highlights header must be flagged');
// The lifter accepts a star-less "## Highlights" too, so the guard must as well
// (else we would invalidate a digest the lifter would happily place at the top).
assert.equal(
  isMissingHighlights(good.replace('## ⭐ Highlights', '## Highlights')),
  false,
  'a star-less "## Highlights" header still counts as present',
);

// ---- stripReasoningTags: clean leaked minimax reasoning ----
//
// When pi's provider adapter fails to route a model's reasoning into the
// JSONL `thinking` channel, the raw <mm:think>…</mm:think> tokens land in the
// `text` body. Strip them defensively.
const paired = '<mm:think>plan the digest</mm:think>## ⭐ Highlights\n- ⭐ a thing';
assert.equal(
  stripReasoningTags(paired),
  '## ⭐ Highlights\n- ⭐ a thing',
  'a well-formed <mm:think> block must be removed entirely',
);

// The observed 07-02 leak: the opener was already stripped as preamble, leaving
// an orphan close tag glued to real content mid-body.
const orphan = 'Now the Highlights block:</mm:think>## ⭐ Highlights\n- ⭐ a thing';
const orphanStripped = stripReasoningTags(orphan);
assert.ok(!orphanStripped.includes('mm:think'), 'an orphan </mm:think> tag must be removed');
assert.ok(orphanStripped.includes('## ⭐ Highlights'), 'stripping an orphan tag must keep the real content');

// Safety valve: if the ENTIRE body is inside one reasoning block, stripping it
// would leave nothing — hand the original back rather than ship an empty digest
// (the highlights guard then flags it instead of silently emptying it).
const allThink = '<mm:think>the whole digest was accidentally written in here and nothing else exists outside the tags</mm:think>';
assert.equal(stripReasoningTags(allThink), allThink, 'stripping must not empty the body — return original as a safety valve');

// A clean digest with no reasoning tags must pass through untouched.
assert.equal(stripReasoningTags(good), good, 'a tag-free body must be returned unchanged');

// ---- generateGuardedDigest: the data-loss protection wiring ----
//
// This is the load-bearing part: a persistently-echoing model must produce a
// result the caller treats as clearSafe=false (status 'invalid'), and the run
// must be RETRIED exactly once first.
const mk = (body: string): DigestResult => ({
  body, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0,
});

(async () => {
  // (a) Persistent echo → retried once (2 calls total) → status 'invalid'.
  let calls = 0;
  let res = await generateGuardedDigest(async () => { calls += 1; return mk(bad); }, 0);
  assert.equal(calls, 2, 'a template echo must trigger exactly one retry (2 calls total)');
  assert.equal(res.status, 'invalid', 'a persistent template echo must yield status=invalid');
  // The caller computes clearSafe = status !== 'invalid' && status !== 'error'.
  assert.equal(res.status === 'invalid' || res.status === 'error', true,
    'invalid status must drive clearSafe=false so notices are NOT cleared');

  // (b) Echo once, then a good digest on retry → recovered, no invalid stamp.
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(calls === 1 ? bad : good); }, 0);
  assert.equal(calls, 2, 'a recovered run still makes 2 calls (1 echo + 1 retry)');
  assert.notEqual(res.status, 'invalid', 'a successful retry must NOT be marked invalid');

  // (c) Good on first try → no retry (1 call), unchanged.
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(good); }, 0);
  assert.equal(calls, 1, 'a good first result must not be retried');
  assert.notEqual(res.status, 'invalid', 'a good result must not be marked invalid');

  // (d) Missing Highlights persists → retried once → status 'invalid'
  //     (the 2026-07-02 data-loss path: must NOT clear notices).
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(noHighlights); }, 0);
  assert.equal(calls, 2, 'a missing-Highlights digest must trigger exactly one retry');
  assert.equal(res.status, 'invalid', 'a persistently missing Highlights block must yield status=invalid');

  // (e) Missing Highlights, then a good digest on retry → recovered.
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(calls === 1 ? noHighlights : good); }, 0);
  assert.equal(calls, 2, 'a recovered missing-Highlights run still makes 2 calls');
  assert.notEqual(res.status, 'invalid', 'a successful retry must NOT be marked invalid');

  // (f) A run ALREADY flagged degraded (partial/rate_limited) may legitimately
  //     lack Highlights — the guard must NOT retry it or override its status.
  calls = 0;
  res = await generateGuardedDigest(async () => {
    calls += 1;
    return { ...mk(noHighlights), status: 'rate_limited' as const };
  }, 0);
  assert.equal(calls, 1, 'an already-degraded run must not be retried by the highlights guard');
  assert.equal(res.status, 'rate_limited', 'the guard must not override a pre-existing degraded status');

  console.log('agent.template-echo.test.ts: all assertions passed ✓');
})();
