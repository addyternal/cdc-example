import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseActor, sanitize, spec, ValidationError } from './tables';

test('unknown table / prototype keys are rejected', () => {
  assert.throws(() => spec('pg_user'), ValidationError);
  assert.throws(() => spec('constructor'), ValidationError);
  assert.throws(() => spec('__proto__'), ValidationError);
});

test('non-editable or unknown columns are rejected (no SQL identifiers from the client)', () => {
  assert.throws(() => sanitize('accounts', { id: 5 }, 'update'), /not editable/);
  assert.throws(() => sanitize('accounts', { 'name; DROP TABLE accounts': 'x' }, 'update'), /not editable/);
});

test('update coerces numbers and blank optional text to null', () => {
  const r = sanitize('accounts', { balance: '12.5', phone: '' }, 'update');
  assert.deepEqual(r.columns, ['balance', 'phone']);
  assert.deepEqual(r.params, [12.5, null]);
});

test('bad number and bad json fail', () => {
  assert.throws(() => sanitize('products', { price: 'abc' }, 'update'), /must be a number/);
  assert.throws(() => sanitize('products', { attrs: '{nope' }, 'update'), /valid JSON/);
  assert.throws(() => sanitize('products', { attrs: '5' }, 'update'), /JSON object/);
});

test('create requires required fields and skips blank defaulted ones', () => {
  assert.throws(() => sanitize('accounts', { name: 'x' }, 'create'), /email is required/);
  const r = sanitize('accounts', { email: 'a@b.c', name: 'A', status: '', balance: '' }, 'create');
  assert.deepEqual(r.columns, ['email', 'name']);
});

test('orders cannot be created directly; empty update rejected', () => {
  assert.throws(() => sanitize('orders', { status: 'paid' }, 'create'), /cannot be created/);
  assert.throws(() => sanitize('accounts', {}, 'update'), /no changes/);
});

test('actor is required and bounded', () => {
  assert.equal(parseActor('  alice '), 'alice');
  assert.throws(() => parseActor(''), ValidationError);
  assert.throws(() => parseActor(undefined), ValidationError);
  assert.throws(() => parseActor('x'.repeat(51)), ValidationError);
});
