// Allow-list of what the UI may touch. Identifiers (table/column names) only ever come from here;
// values are always bound parameters, so nothing user-supplied is interpolated into SQL.

export type ColType = 'text' | 'number' | 'json';
export interface Col { name: string; type: ColType; required?: boolean }
export interface TableSpec {
  cols: Col[];
  creatable: boolean; // orders/items are created via the place-order flow
  touch?: string;     // column set to now() on every update
}

export const TABLES: Record<string, TableSpec> = {
  accounts: {
    creatable: true,
    touch: 'updated_at',
    cols: [
      { name: 'email', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'status', type: 'text' },
      { name: 'balance', type: 'number' },
      { name: 'phone', type: 'text' },
      { name: 'nickname', type: 'text' },
      { name: 'profile', type: 'json' },
    ],
  },
  products: {
    creatable: true,
    cols: [
      { name: 'sku', type: 'text', required: true },
      { name: 'name', type: 'text', required: true },
      { name: 'price', type: 'number', required: true },
      { name: 'stock', type: 'number' },
      { name: 'attrs', type: 'json' },
    ],
  },
  orders: {
    creatable: false,
    cols: [
      { name: 'status', type: 'text' },
      { name: 'total', type: 'number' },
    ],
  },
  order_items: {
    creatable: false,
    cols: [{ name: 'qty', type: 'number' }, { name: 'unit_price', type: 'number' }],
  },
};

export class ValidationError extends Error {}

export function spec(table: string): TableSpec {
  const s = Object.prototype.hasOwnProperty.call(TABLES, table) ? TABLES[table] : undefined;
  if (!s) throw new ValidationError(`unknown table: ${table}`);
  return s;
}

export function parseActor(actor: unknown): string {
  if (typeof actor !== 'string' || !actor.trim()) throw new ValidationError('actor is required');
  const a = actor.trim();
  if (a.length > 50) throw new ValidationError('actor must be 50 characters or fewer');
  return a;
}

function coerce(col: Col, v: unknown): unknown {
  if (v === null || v === undefined || v === '') {
    if (col.required) throw new ValidationError(`${col.name} is required`);
    return null;
  }
  if (col.type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new ValidationError(`${col.name} must be a number`);
    return n;
  }
  if (col.type === 'json') {
    let parsed: unknown = v;
    if (typeof v === 'string') {
      try { parsed = JSON.parse(v); } catch { throw new ValidationError(`${col.name} must be valid JSON`); }
    }
    if (parsed === null || typeof parsed !== 'object') throw new ValidationError(`${col.name} must be a JSON object or array`);
    return JSON.stringify(parsed);
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new ValidationError(`${col.name} must be text`);
  const s = String(v).trim();
  if (s.length > 500) throw new ValidationError(`${col.name} is too long`);
  return s;
}

/** Validate user values against the allow-list. Returns parallel column/param arrays. */
export function sanitize(table: string, values: unknown, mode: 'create' | 'update') {
  const s = spec(table);
  if (mode === 'create' && !s.creatable) throw new ValidationError(`${table} rows cannot be created directly`);
  if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new ValidationError('values must be an object');
  const input = values as Record<string, unknown>;
  const allowed = new Map(s.cols.map((c) => [c.name, c]));
  for (const k of Object.keys(input)) if (!allowed.has(k)) throw new ValidationError(`column not editable: ${k}`);

  const columns: string[] = [];
  const params: unknown[] = [];
  for (const col of s.cols) {
    const present = Object.prototype.hasOwnProperty.call(input, col.name);
    if (mode === 'create' && col.required && !present) throw new ValidationError(`${col.name} is required`);
    if (!present) continue;
    const v = coerce(col, input[col.name]);
    // Omitted/blank optional values on create fall back to the column default instead of forcing NULL.
    if (mode === 'create' && v === null && !col.required && ['status', 'balance', 'stock', 'profile', 'attrs'].includes(col.name)) continue;
    columns.push(col.name);
    params.push(v);
  }
  if (mode === 'update' && columns.length === 0) throw new ValidationError('no changes supplied');
  return { columns, params, spec: s };
}
