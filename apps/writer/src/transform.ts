import { isDeepStrictEqual } from 'node:util';

export type Row = Record<string, unknown>;

export interface AuditRow {
  lsn: string; // bigint as string to avoid precision loss
  sourceTable: string;
  pk: Row;
  op: 'r' | 'c' | 'u' | 'd';
  before: Row | null;
  after: Row | null;
  changedFields: string[];
  txId: number | null;
  sourceTs: Date;
}

export interface TxActorRow {
  txId: number;
  lsn: string;
  actor: string | null;
  meta: Row;
}

// Debezium emits jsonb columns as JSON *strings*; parse them so they diff and query as JSON.
const JSONB_COLUMNS: Record<string, string[]> = {
  accounts: ['profile'],
  products: ['attrs'],
};

function parseJsonbColumns(table: string, row: Row | null): Row | null {
  if (!row) return row;
  const out = { ...row };
  for (const col of JSONB_COLUMNS[table] ?? []) {
    const v = out[col];
    if (typeof v === 'string') {
      try {
        out[col] = JSON.parse(v);
      } catch {
        /* leave as string */
      }
    }
  }
  return out;
}

export function changedFields(op: string, before: Row | null, after: Row | null): string[] {
  if (op === 'r') return [];
  if (op === 'c') return Object.keys(after ?? {});
  if (op === 'd') return Object.keys(before ?? {});
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => !isDeepStrictEqual(before?.[k], after?.[k])).sort();
}

/** Parse a table-change stream entry ([keyJson, valueJson]) into an audit row. */
export function toAuditRow(keyJson: string, valueJson: string): AuditRow {
  const key = JSON.parse(keyJson) as Row;
  const v = JSON.parse(valueJson);
  const op = v.op as AuditRow['op'];
  if (!['r', 'c', 'u', 'd'].includes(op)) throw new Error(`unsupported op: ${op}`);
  const table: string = v.source.table;
  const before = parseJsonbColumns(table, v.before ?? null);
  const after = parseJsonbColumns(table, v.after ?? null);
  return {
    lsn: String(v.source.lsn),
    sourceTable: table,
    pk: key,
    op,
    before,
    after,
    changedFields: changedFields(op, before, after),
    txId: v.source.txId ?? null,
    sourceTs: new Date(v.source.ts_ms),
  };
}

/** Parse a logical-decoding message ("audit" prefix) into a tx actor row, or null if not ours. */
export function toTxActor(valueJson: string): TxActorRow | null {
  const v = JSON.parse(valueJson);
  const msg = v.message;
  if (!msg || msg.prefix !== 'audit') return null;
  const content = JSON.parse(Buffer.from(msg.content, 'base64').toString('utf8')) as Row;
  const { actor, ...meta } = content;
  return {
    txId: v.source.txId,
    lsn: String(v.source.lsn),
    actor: typeof actor === 'string' ? actor : null,
    meta,
  };
}
