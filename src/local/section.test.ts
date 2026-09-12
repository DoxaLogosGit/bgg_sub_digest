// ============================================================
// local/section.test.ts — structure from the manifest, prose from the model
// ============================================================
//
// Standalone. Run: npx tsx src/local/section.test.ts
//
// WHAT THIS GUARDS (2026-09-11 spike): asked to produce a whole section, the
// local model wrote a bare "### Question about traits..." with no markdown
// link. That scores 0 sections and trips isTruncatedDigest. The manifest
// already holds the title and url, so code emits them and the model never
// writes a link it can get wrong.

import assert from 'node:assert/strict';
import { assembleSection, matchTopics } from './section';
import type { ManifestEntry } from '../agent';
import type { InterestsConfig } from '../interests';

const cfg: InterestsConfig = {
  priorityTitles: ['SGOYT'],
  trackedGames:   ['Spirit Island', "Star Trek: Captain's Chair"],
  keywords:       ['solo', 'expansion'],
  notes:          '',
};

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    subscriptionId: 42,
    type: 'thread',
    title: 'Best solo train game?',
    url: 'https://boardgamegeek.com/thread/3765831/best-train-game',
    filePath: '/tmp/thread-3765831.md',
    itemCount: 5,
    unreadCount: 5,
    notificationDate: null,
    ...over,
  };
}

const PROSE = '**Summary:** Members debated engine-building trains.\n\n**New Activity:**\n- alice — recommends Irish Gauge.';

// ---- the header comes from the MANIFEST, never the model ----
{
  const s = assembleSection(entry(), PROSE, []);
  assert.ok(
    s.startsWith('### [Best solo train game?](https://boardgamegeek.com/thread/3765831/best-train-game)\n'),
    'the section opens with the exact manifest title and url',
  );
}

// ---- the Parent line appears only when parentName is set ----
{
  const withParent = assembleSection(entry({ parentName: '1 Player guild' }), PROSE, []);
  assert.match(withParent, /^\*Parent: 1 Player guild\*$/m);
  assert.ok(!assembleSection(entry(), PROSE, []).includes('*Parent:'),
    'no empty Parent line is ever emitted');
}

// ---- the replies-to-you line appears only when selfActivity is present ----
{
  const withReplies = assembleSection(
    entry({ selfActivity: { reasons: ['2 comments on your item "Tarawa 1943"'], replyCount: 2 } }),
    PROSE, []);
  assert.match(withReplies, /^\*\*💬 Replies to you:\*\* 2 comments on your item "Tarawa 1943"$/m);
  assert.ok(!assembleSection(entry(), PROSE, []).includes('Replies to you'));
}

// ---- several reasons join with "; " ----
{
  const s = assembleSection(
    entry({ selfActivity: { reasons: ['3 replies in a thread you started', '1 post quoting you'], replyCount: 4 } }),
    PROSE, []);
  assert.match(s, /Replies to you:\*\* 3 replies in a thread you started; 1 post quoting you/);
}

// ---- the model's prose is inserted verbatim ----
{
  const s = assembleSection(entry(), PROSE, []);
  assert.ok(s.includes('**Summary:** Members debated engine-building trains.'));
  assert.ok(s.includes('- alice — recommends Irish Gauge.'));
}

// ---- Topics Mentioned is computed in CODE and closes the section ----
{
  assert.match(assembleSection(entry(), PROSE, ['solo', 'Spirit Island']),
    /\*\*Topics Mentioned:\*\* solo, Spirit Island\s*$/);
  assert.match(assembleSection(entry(), PROSE, []), /\*\*Topics Mentioned:\*\* none\s*$/);
}

// ---- matchTopics finds tracked games and keywords, case-insensitively ----
{
  const topics = matchTopics('I played Spirit Island SOLO last night. The expansion is great.', cfg);
  assert.ok(topics.includes('Spirit Island'), 'tracked game matched');
  assert.ok(topics.includes('solo'), 'keyword matched case-insensitively');
  assert.ok(topics.includes('expansion'), 'second keyword matched');
  assert.ok(!topics.includes("Star Trek: Captain's Chair"), 'absent games are not reported');
}

// ---- matchTopics does not repeat a term ----
{
  const topics = matchTopics('solo solo solo Spirit Island Spirit Island', cfg);
  assert.equal(topics.filter((t) => t === 'solo').length, 1);
  assert.equal(topics.filter((t) => t === 'Spirit Island').length, 1);
}

// ---- a keyword written as "solo / solitaire" matches either side ----
//
// interests.toml keeps human-readable entries; the slash is a list, not a
// literal to search for.
{
  const slashCfg: InterestsConfig = { ...cfg, keywords: ['solo / solitaire'] };
  assert.ok(matchTopics('a solitaire session', slashCfg).length > 0,
    'either side of a slashed keyword matches');
}

// ---- the assembled section survives the existing section counter ----
//
// isTruncatedDigest counts /^[ \t]*###[ \t]+\[/ — the whole point of building
// the header in code is that this can never miss.
{
  const s = assembleSection(entry(), PROSE, ['solo']);
  assert.equal((s.match(/^[ \t]*###[ \t]+\[/gm) ?? []).length, 1,
    'the assembled section is counted by the pipeline guard');
}

console.log('section.test.ts: all assertions passed ✓');
