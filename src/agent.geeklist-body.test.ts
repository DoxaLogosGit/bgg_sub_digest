// ============================================================
// agent.geeklist-body.test.ts — trimming already-read item bodies
// ============================================================
//
// Standalone (no test framework). Run:
//   npx tsx src/agent.geeklist-body.test.ts
//
// WHAT THIS GUARDS: when an OLD geeklist item picks up a NEW comment, the
// item is selected for the digest and its whole body — up to 1000 chars the
// reader saw weeks ago — rides along to deliver that one comment. Measured on
// SGOYT August 2026 (843 items): 1% of the data file early in the month,
// rising to 28% (17.6KB of 62KB) by the 31st as activity shifts from new
// posts to discussion on existing ones.
//
// The trim must not fire on anything that is actually news. The sharp case is
// an OLD item EDITED since the cutoff: itemsWithActivityNewerThan selects it
// precisely because the body changed, so the body IS the new content.

import assert from 'node:assert/strict';
import { formatGeeklistContent } from './agent';
import type { BggGeeklistItem } from './types';

const cutoff = new Date('2026-09-05T00:00:00Z');
const OLD    = new Date('2026-08-01T09:00:00Z');
const NEW    = new Date('2026-09-05T12:00:00Z');

const LONG_BODY =
  'I finally got this to the table after months on the shelf of shame. ' +
  'The automa is genuinely brutal on the higher difficulties and I lost my ' +
  'first four attempts before working out that you have to race the second ' +
  'track rather than the first. Once that clicked the whole thing opened up ' +
  'and I have played it every evening since, which is not something I say often.';

function item(over: Partial<BggGeeklistItem> & { id: number }): BggGeeklistItem {
  return {
    username: 'list_regular',
    postdate: OLD,
    editdate: OLD,
    objectName: `Game ${over.id}`,
    objectId: over.id,
    body: LONG_BODY,
    link: `https://boardgamegeek.com/geeklist/1#item${over.id}`,
    comments: [{ username: 'alice', date: NEW, body: 'The automa is brutal, agreed.' }],
    ...over,
  };
}

const MARKER = 'excerpt only';

// ---- 1. an OLD item carrying new comments is trimmed ----
{
  const out = formatGeeklistContent('L', [item({ id: 1 })], cutoff);

  assert.ok(out.includes(MARKER), 'an already-read body must be marked as an excerpt');
  assert.ok(!out.includes('every evening since'),
    'the tail of an already-read body must not be shipped');
  assert.ok(out.includes('I finally got this to the table'),
    'a lead must survive so the comments have an anchor');

  // Everything that makes the item usable is still there.
  assert.ok(out.includes('Game 1'), 'the game name survives');
  assert.ok(out.includes('#item1'), 'the link survives');
  assert.ok(out.includes('The automa is brutal, agreed.'),
    'the NEW comment — the whole reason the item was selected — must survive intact');
}

// ---- 2. a NEW item keeps its full body ----
{
  const out = formatGeeklistContent('L', [item({ id: 2, postdate: NEW, editdate: NEW })], cutoff);
  assert.ok(out.includes('every evening since'), 'a new item is not trimmed');
  assert.ok(!out.includes(MARKER), 'a new item carries no excerpt marker');
}

// ---- 3. an OLD item EDITED since the cutoff keeps its full body ----
//
// itemsWithActivityNewerThan selects on editdate too. If the body was rewritten
// after the cutoff, the body is exactly what is new — trimming it would hide
// the news the selection was made for.
{
  const out = formatGeeklistContent('L', [item({ id: 3, postdate: OLD, editdate: NEW })], cutoff);
  assert.ok(out.includes('every evening since'),
    'an item edited since the cutoff must keep its full body — the edit IS the news');
  assert.ok(!out.includes(MARKER), 'an edited item carries no excerpt marker');
}

// ---- 4. a short already-read body is left alone ----
{
  const out = formatGeeklistContent('L', [item({ id: 4, body: 'Played it twice. Good.' })], cutoff);
  assert.ok(out.includes('Played it twice. Good.'), 'a short body survives whole');
  assert.ok(!out.includes(MARKER), 'nothing was cut, so nothing is marked');
}

// ---- 5. with no cutoff we cannot tell old from new — trim nothing ----
{
  const out = formatGeeklistContent('L', [item({ id: 5 })], null);
  assert.ok(out.includes('every evening since'),
    'an unparseable notification date must not cause silent trimming');
  assert.ok(!out.includes(MARKER));
}

// ---- 6. the cut lands on a word boundary ----
{
  const out = formatGeeklistContent('L', [item({ id: 6 })], cutoff);
  const excerpt = out.split('…')[0].split('\n').pop() ?? '';
  assert.ok(LONG_BODY.startsWith(excerpt.trim()),
    'the excerpt must be a real prefix of the body, not a re-flowed string');
  assert.ok(!/\w$/.test(excerpt.trim()) || LONG_BODY.slice(excerpt.trim().length).startsWith(' '),
    'the cut must fall on a word boundary, not mid-word');
}

// ---- 7. the trim actually saves what it claims ----
//
// The measured case: 24 already-read items in one SGOYT run. Assert the
// direction and rough magnitude so a future change to the lead length can't
// quietly make this pointless.
{
  const many = Array.from({ length: 24 }, (_, i) => item({ id: 100 + i }));
  const trimmed = formatGeeklistContent('L', many, cutoff).length;
  const full    = formatGeeklistContent('L', many, null).length;

  assert.ok(trimmed < full, 'trimming must actually shrink the file');
  const saved = 1 - trimmed / full;
  assert.ok(saved > 0.15,
    `expected the trim to save >15% on an all-stale selection, saved ${(saved * 100).toFixed(0)}%`);
}

console.log('agent.geeklist-body.test.ts: all assertions passed ✓');
