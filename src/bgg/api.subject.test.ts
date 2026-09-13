// ============================================================
// api.subject.test.ts — the thread title is a CHILD element
// ============================================================
//
// Standalone. Run: npx tsx src/bgg/api.subject.test.ts
//
// From the initial commit until 2026-09-13 the title was read as an attribute
// of <thread>, so every thread came back untitled ("=== Thread:  ==="). The
// fixture is the head of a live response for thread 3767381, captured that day.

import assert from 'node:assert/strict';
import * as xml2js from 'xml2js';
import { threadSubject } from './api';

const LIVE =
  '<?xml version="1.0" encoding="utf-8"?><thread id="3767381" numarticles="6" ' +
  'link="https://boardgamegeek.com/thread/3767381" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">\n' +
  '<subject>Mage Knight, Kinfire Chronicles, or Fateforge?</subject>\n<articles></articles></thread>';

async function main() {
  // Same options as api.ts parseXml.
  const parsed = await xml2js.parseStringPromise(LIVE, { explicitArray: false, mergeAttrs: false, trim: true });
  const threadNode = parsed.thread as Record<string, unknown>;

  assert.equal(threadSubject(threadNode), 'Mage Knight, Kinfire Chronicles, or Fateforge?');

  // An element that ever gains attributes parses to { _: text, $: {...} }.
  assert.equal(threadSubject({ subject: { _: 'With attrs', $: { lang: 'en' } } }), 'With attrs');

  // No title at all is empty, not "undefined".
  assert.equal(threadSubject({ $: { id: '1' } }), '');

  console.log('api.subject.test.ts: all assertions passed ✓');
}

main().catch((e) => { console.error(e); process.exit(1); });
