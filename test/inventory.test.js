import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseInventorySummaryArgs
} from '../src/tools/inventoryArgs.js';

test('rejects inventory limits above 100', () => {
  assert.throws(
    () => parseInventorySummaryArgs({ limit: 500 }),
    /limit/i
  );
});

test('accepts valid inventory arguments', () => {
  const result = parseInventorySummaryArgs({
    set_name: 'Gothic',
    sort_by: 'market_price',
    limit: 10
  });

  assert.equal(result.set_name, 'Gothic');
  assert.equal(result.sort_by, 'market_price');
  assert.equal(result.limit, 10);
});

test('validates inventory limit boundaries', () => {
  for (const limit of [99, 100]) {
    assert.doesNotThrow(() =>
      parseInventorySummaryArgs({ limit })
    );
  }

  for (const limit of [101, -100]) {
    assert.throws(() =>
      parseInventorySummaryArgs({ limit }),
      /limit/i
    );
  }
});