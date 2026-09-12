// ============================================================
// config.tiers.test.ts — which models does a run use, in what order?
// ============================================================
//
// Standalone. Run: npx tsx src/config.tiers.test.ts
//
// WHY TIERS EXIST: local inference is unmetered and cloud is not. On
// 2026-09-11 the pipeline exhausted the monthly quota on BOTH providers in a
// day. Local-first makes a typical night cost nothing; the flags let the
// operator force either side when they have a reason.

import assert from 'node:assert/strict';
import { resolveTiers } from './config';

const cfg = { localModel: 'omnicoder-oc', cloudModel: 'nemotron-3-super:cloud' };

// ---- default: local first, cloud available for escalation ----
{
  const t = resolveTiers([], cfg);
  assert.deepEqual(t.models, ['omnicoder-oc', 'nemotron-3-super:cloud']);
  assert.equal(t.escalates, true);
}

// ---- --local-only: never spends a metered token ----
{
  const t = resolveTiers(['--local-only'], cfg);
  assert.deepEqual(t.models, ['omnicoder-oc']);
  assert.equal(t.escalates, false, 'there is nothing to escalate to');
}

// ---- --cloud-only: skip local entirely ----
{
  const t = resolveTiers(['--cloud-only'], cfg);
  assert.deepEqual(t.models, ['nemotron-3-super:cloud']);
  assert.equal(t.escalates, false);
}

// ---- --model X overrides both tiers ----
{
  const t = resolveTiers(['--model', 'gemma4:31b-cloud'], cfg);
  assert.deepEqual(t.models, ['gemma4:31b-cloud'],
    'an explicit model is used alone, with no tiering');
  assert.equal(t.escalates, false);
}

// ---- --model wins even alongside a tier flag ----
//
// The operator named a model. Silently running a different one would be worse
// than any tiering benefit.
{
  const t = resolveTiers(['--local-only', '--model', 'granite4.1:8b'], cfg);
  assert.deepEqual(t.models, ['granite4.1:8b']);
}

// ---- conflicting flags fail loudly rather than picking silently ----
{
  assert.throws(() => resolveTiers(['--local-only', '--cloud-only'], cfg),
    /both --local-only and --cloud-only/i,
    'a contradiction must be an error, not a silent preference');
}

// ---- a --model with no value is ignored rather than crashing ----
{
  const t = resolveTiers(['--model'], cfg);
  assert.deepEqual(t.models, ['omnicoder-oc', 'nemotron-3-super:cloud'],
    'a dangling --model falls back to the default tiers');
}

console.log('config.tiers.test.ts: all assertions passed ✓');
