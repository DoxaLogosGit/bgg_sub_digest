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
import { isTemplateEcho, generateGuardedDigest, type DigestResult } from './agent';

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
  let res = await generateGuardedDigest(async () => { calls += 1; return mk(bad); });
  assert.equal(calls, 2, 'a template echo must trigger exactly one retry (2 calls total)');
  assert.equal(res.status, 'invalid', 'a persistent template echo must yield status=invalid');
  // The caller computes clearSafe = status !== 'invalid' && status !== 'error'.
  assert.equal(res.status === 'invalid' || res.status === 'error', true,
    'invalid status must drive clearSafe=false so notices are NOT cleared');

  // (b) Echo once, then a good digest on retry → recovered, no invalid stamp.
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(calls === 1 ? bad : good); });
  assert.equal(calls, 2, 'a recovered run still makes 2 calls (1 echo + 1 retry)');
  assert.notEqual(res.status, 'invalid', 'a successful retry must NOT be marked invalid');

  // (c) Good on first try → no retry (1 call), unchanged.
  calls = 0;
  res = await generateGuardedDigest(async () => { calls += 1; return mk(good); });
  assert.equal(calls, 1, 'a good first result must not be retried');
  assert.notEqual(res.status, 'invalid', 'a good result must not be marked invalid');

  console.log('agent.template-echo.test.ts: all assertions passed ✓');
})();
