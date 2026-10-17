import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRows } from './diff';

test('diff reports only changed fields', () => {
  assert.deepEqual(diffRows({ a: 1, b: 2 }, { a: 1, b: 3 }), [{ field: 'b', from: 2, to: 3 }]);
});

test('insert and delete diff against null', () => {
  assert.deepEqual(diffRows(null, { a: 1 }), [{ field: 'a', from: null, to: 1 }]);
  assert.deepEqual(diffRows({ a: 1 }, null), [{ field: 'a', from: 1, to: null }]);
});

test('nested jsonb compared deeply', () => {
  assert.deepEqual(diffRows({ p: { x: 1 } }, { p: { x: 1 } }), []);
});
