import assert from 'node:assert/strict';
import test from 'node:test';

import { canUseDemoPreview, getDemoPreviewCopy } from './demoPreview.ts';

test('demo preview is available only in development, including configured auth builds', () => {
  assert.equal(canUseDemoPreview(true), true);
  assert.equal(canUseDemoPreview(false), false);
});

test('demo preview copy exists for every supported language', () => {
  for (const language of ['en', 'pt', 'fr', 'de', 'zh', 'it', 'es'] as const) {
    const copy = getDemoPreviewCopy(language);
    assert.ok(copy.button.length > 0);
    assert.ok(copy.note.length > 0);
  }
});
