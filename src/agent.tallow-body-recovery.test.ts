// ============================================================
// agent.tallow-body-recovery.test.ts — unit tests for selectDigestBody()
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/agent.tallow-body-recovery.test.ts
//
// Guards the 2026-08-07 failure mode (ollama/minimax-m3:cloud, 49-subscription
// run): the model's synthesis text turn was cut off mid-sentence before it
// reached the Highlights block. In the NEXT turn it — in violation of the
// explicit "do NOT use the Write tool" CLAUDE.md instruction — called its
// `write` tool with the COMPLETE, correctly-formatted digest (verified via the
// live tallow session transcript: `arguments.content` was 33,508 chars and
// included a real "## ⭐ Highlights" header), then closed with an unrelated
// short wrap-up text turn ("The digest is written to digest-data/digest-
// output.md. Here's a quick summary of what was built...").
//
// The old backward-walk only inspected `type:'text'` content items and
// returned the newest non-empty one — the wrap-up — discarding the real
// digest sitting one turn earlier in the `write` toolCall. isMissingHighlights
// correctly flagged the wrap-up as defective, but the automatic retry this
// triggered ran the flaky model again from scratch instead of recovering
// content that was already on the stream — and that retry's output was the
// one that actually got shipped, badly garbled.
//
// selectDigestBody must recover the `write` toolCall's content when it's the
// only candidate with a real Highlights block, while leaving normal runs
// (Highlights already in the last text turn) and genuinely-broken runs
// (no candidate anywhere has Highlights) unaffected.

import assert from 'node:assert/strict';
import { selectDigestBody } from './agent';

const GOOD_DIGEST = `## ⭐ Highlights

- ⭐ **Star Trek: Captain's Chair** — Active across 4 threads.

### [Solitaire Games on Your Table](https://boardgamegeek.com/geeklist/381969)

**Summary:** Heavy activity this week.

**New Activity:**
- ⭐ rdrcksmith kicks off a Five Year Mission campaign.

**Topics Mentioned:** solo
`;

const NO_HIGHLIGHTS = `### [Some Thread](https://boardgamegeek.com/thread/1)

**Summary:** Two new replies.

**New Activity:**
- somebody said a thing.

**Topics Mentioned:** solo
`;

// ---- (a) The 2026-08-07 incident, reproduced from the captured shape ----
//
// Turn 0: tool-only round (a Read call) — no text, no write.
// Turn 1: synthesis text cut off before the Highlights block.
// Turn 2: the model calls `write` with the COMPLETE digest.
// Turn 3: a short unrelated wrap-up text turn — the one the old code picked.
const incidentTurns = [
  {
    type: 'turn_end',
    message: {
      model: 'minimax-m3', provider: 'ollama',
      content: [{ type: 'toolCall', name: 'read', arguments: { path: 'manifest.json' } }],
    },
  },
  {
    type: 'turn_end',
    message: {
      model: 'minimax-m3', provider: 'ollama',
      content: [{ type: 'text', text: 'Now let me build the digest.\n\n### [Solitaire Games on Your Table]...\n\nNow the Highlights block. Let me identify the cross-subscription themes:' }],
    },
  },
  {
    type: 'turn_end',
    message: {
      model: 'minimax-m3', provider: 'ollama',
      content: [{ type: 'toolCall', name: 'write', arguments: { path: 'digest-output.md', content: GOOD_DIGEST } }],
    },
  },
  {
    type: 'turn_end',
    message: {
      model: 'minimax-m3', provider: 'ollama',
      content: [{ type: 'text', text: "The digest is written to `digest-data/digest-output.md`. Here's a quick summary of what was built: 49 subscriptions rendered in full." }],
    },
  },
];

{
  const { body, turnIndex } = selectDigestBody(incidentTurns);
  assert.equal(body, GOOD_DIGEST, 'must recover the write toolCall content, not the trailing wrap-up text');
  assert.equal(turnIndex, 2, 'must report the turn the recovered body actually came from');
}

// ---- (b) Normal run: Highlights already in the last text turn ----
//
// The overwhelmingly common case — must be completely unaffected by the
// write-tool recovery path (no write toolCall present at all).
{
  const normalTurns = [
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'toolCall', name: 'read', arguments: {} }] } },
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'text', text: GOOD_DIGEST }] } },
  ];
  const { body, turnIndex } = selectDigestBody(normalTurns);
  assert.equal(body, GOOD_DIGEST, 'a normal run must return the text turn unchanged');
  assert.equal(turnIndex, 1, 'turnIndex must point at the text turn');
}

// ---- (c) Genuinely broken run: NO candidate anywhere has a Highlights block ----
//
// Must fall back to the ORIGINAL behavior (newest non-empty text) so
// isMissingHighlights still flags it and generateGuardedDigest still retries —
// this guard must not be weakened by the recovery logic.
{
  const brokenTurns = [
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'text', text: 'earlier partial text' }] } },
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'text', text: NO_HIGHLIGHTS }] } },
  ];
  const { body, turnIndex } = selectDigestBody(brokenTurns);
  assert.equal(body, NO_HIGHLIGHTS, 'with no Highlights anywhere, must fall back to the newest non-empty text turn');
  assert.equal(turnIndex, 1, 'fallback must point at the newest text turn');
}

// ---- (d) A write toolCall whose content is ALSO defective must not be
//     preferred over a later turn that has real content — recovery only
//     fires for a candidate that actually clears the isMissingHighlights bar.
{
  const stillBadTurns = [
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'toolCall', name: 'write', arguments: { path: 'x.md', content: NO_HIGHLIGHTS } }] } },
    { type: 'turn_end', message: { model: 'm', provider: 'p', content: [{ type: 'text', text: 'also no highlights here' }] } },
  ];
  const { body } = selectDigestBody(stillBadTurns);
  assert.equal(body, 'also no highlights here', 'a defective write payload must not be preferred over the fallback text');
}

// ---- (e) No turns at all → empty result, matching original "no body" path ----
{
  const { body, turnIndex } = selectDigestBody([]);
  assert.equal(body, '', 'no turns must yield an empty body');
  assert.equal(turnIndex, -1, 'no turns must yield turnIndex -1');
}

console.log('agent.tallow-body-recovery.test.ts: all assertions passed ✓');
