// ============================================================
// agent.parent-line.test.ts — the "*Parent:*" line
// ============================================================
//
// Standalone test (the project has no test framework). Run it with:
//   npx tsx src/agent.parent-line.test.ts
//
// WHAT IT GUARDS (observed 2026-09-04, pi + nemotron-3-super:cloud):
//
//   Every rendered section carried a dangling em dash, and the 7 sections
//   whose subscription had no parent game got an empty label:
//
//       *Parent: Marvel Champions: The Card Game* —
//       *Parent: * —
//
//   Root cause was templates/section.md, which put the pattern and its own
//   usage note on ONE line ("*Parent: <parentName>* — only include this line
//   if `parentName` is set"), so a model reproducing the structure faithfully
//   copied the separator that introduced the note. The template is fixed; this
//   is the belt-and-braces repair, because the digest runs unattended at 3am
//   against a model that ignores instructions under load.

import assert from 'node:assert/strict';
import { tidyParentLines, postProcessDigestBody } from './agent';

// ---- 1. an empty parent drops the whole line ----
// No parentName in the manifest means the template asks for no line at all.
{
  const out = tidyParentLines(
    '### [Some Thread](https://boardgamegeek.com/thread/1)\n' +
    '*Parent: * — \n' +
    '\n**Summary:** Something happened.\n',
  );

  assert.ok(!out.includes('Parent'), `empty parent line must go: ${JSON.stringify(out)}`);
  assert.ok(out.includes('**Summary:** Something happened.'), 'real content must survive');
  assert.ok(out.includes('### [Some Thread]'), 'the header must survive');
}

// ---- 2. a real parent keeps its name, loses only the trailing separator ----
{
  const out = tidyParentLines('*Parent: Marvel Champions: The Card Game* — \n');

  assert.equal(out, '*Parent: Marvel Champions: The Card Game*\n');
}

// ---- 3. a parent name containing a dash is not damaged ----
// The repair must anchor on the CLOSING asterisk, not on any dash it finds,
// or a game like "Spirit Island - Horizons" would lose half its name.
{
  const out = tidyParentLines('*Parent: Star Wars: X-Wing — Second Edition*\n');

  assert.equal(out, '*Parent: Star Wars: X-Wing — Second Edition*\n', 'name must be untouched');
}

// ---- 4. an already-clean line is left exactly alone ----
{
  const clean = '*Parent: Deckers*\n';
  assert.equal(tidyParentLines(clean), clean);
}

// ---- 5. it does not touch prose that merely mentions a parent ----
{
  const prose = 'The parent game *Parent: not a real line* is discussed — at length.\n';
  assert.equal(tidyParentLines(prose), prose, 'mid-line text must be untouched');
}

// ---- 6. end-to-end through the real pipeline ----
// The repair has to survive the ordering in postProcessDigestBody: it runs
// before stripBlockNarration, which keys on block boundaries, so a repaired
// section must still be parsed as one block with its content intact.
{
  const body =
    '### [Thread A](https://boardgamegeek.com/thread/1)\n' +
    '*Parent: * — \n\n' +
    '**Summary:** First thing.\n\n' +
    '**New Activity:**\n- alice said something.\n\n' +
    '**Topics Mentioned:** solo\n\n' +
    '### [Thread B](https://boardgamegeek.com/thread/2)\n' +
    '*Parent: Deckers* — \n\n' +
    '**Summary:** Second thing.\n\n' +
    '**New Activity:**\n- bob said something else.\n\n' +
    '**Topics Mentioned:** none\n\n' +
    '## ⭐ Highlights\n\n- ⭐ Deckers — a real highlight.\n';

  const out = postProcessDigestBody(body);

  assert.ok(!/\*Parent:\s*\*/.test(out), 'no empty parent survives the pipeline');
  assert.ok(out.includes('*Parent: Deckers*'), 'the real parent survives');
  assert.ok(!/\*Parent: Deckers\*\s*—/.test(out), 'its dangling dash is gone');
  // Both sections and their content must still be there.
  assert.ok(out.includes('alice said something'), 'section A content survives');
  assert.ok(out.includes('bob said something else'), 'section B content survives');
  assert.equal((out.match(/^### \[/gm) ?? []).length, 2, 'both sections survive');
  assert.ok(out.includes('## ⭐ Highlights'), 'Highlights survive');
}

console.log('✓ agent.parent-line.test.ts — all assertions passed');
