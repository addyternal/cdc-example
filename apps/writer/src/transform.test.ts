import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, toAuditRow, toTxActor } from './transform';

const src = (table: string) => ({ table, lsn: 100, txId: 7, ts_ms: 1700000000000 });

test('update lists only changed fields', () => {
  assert.deepEqual(changedFields('u', { a: 1, b: 2, c: { x: 1 } }, { a: 1, b: 3, c: { x: 1 } }), ['b']);
});

test('jsonb deep-equal is not a change', () => {
  assert.deepEqual(changedFields('u', { p: { x: [1, 2] } }, { p: { x: [1, 2] } }), []);
});

test('create lists all, delete lists all, snapshot lists none', () => {
  assert.deepEqual(changedFields('c', null, { a: 1, b: 2 }), ['a', 'b']);
  assert.deepEqual(changedFields('d', { a: 1 }, null), ['a']);
  assert.deepEqual(changedFields('r', null, { a: 1 }), []);
});

test('toAuditRow parses jsonb strings and keeps lsn as string', () => {
  const row = toAuditRow(
    '{"id":1}',
    JSON.stringify({
      op: 'u',
      before: { id: 1, profile: '{"tier":"a"}' },
      after: { id: 1, profile: '{"tier":"b"}' },
      source: src('accounts'),
    }),
  );
  assert.equal(row.lsn, '100');
  assert.deepEqual(row.after?.profile, { tier: 'b' });
  assert.deepEqual(row.changedFields, ['profile']);
  assert.equal(row.txId, 7);
});

test('toAuditRow rejects unknown op', () => {
  assert.throws(() => toAuditRow('{"id":1}', JSON.stringify({ op: 'x', source: src('t') })));
});

test('toTxActor decodes base64 payload and ignores other prefixes', () => {
  const content = Buffer.from('{"actor":"alice","reason":"fix"}').toString('base64');
  const ok = toTxActor(JSON.stringify({ source: src(''), message: { prefix: 'audit', content } }));
  assert.deepEqual(ok, { txId: 7, lsn: '100', actor: 'alice', meta: { reason: 'fix' } });
  assert.equal(toTxActor(JSON.stringify({ source: src(''), message: { prefix: 'other', content } })), null);
});
