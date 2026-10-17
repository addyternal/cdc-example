import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { diffRows } from './diff';

const AUDIT_URL = process.env.AUDIT_DATABASE_URL ?? 'postgres://cdc_audit:cdc_audit_pw@localhost:5432/cdc_audit';

// Table names come from the URL; only ever interpolated as bound parameters, but we also allow-list.
const TABLES = new Set(['accounts', 'products', 'orders', 'order_items']);

export function assertTable(t: string): string {
  if (!TABLES.has(t)) throw new Error(`unknown table: ${t}`);
  return t;
}

@Injectable()
export class AuditService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: AUDIT_URL, max: 5 });

  async stats() {
    const [tables, total, actors] = await Promise.all([
      this.pool.query(`SELECT source_table AS "table", count(*)::int AS events, count(DISTINCT pk)::int AS rows
                       FROM audit_event GROUP BY 1 ORDER BY 1`),
      this.pool.query(`SELECT count(*)::int AS events, max(source_ts) AS latest FROM audit_event`),
      this.pool.query(`SELECT actor, count(*)::int AS changes FROM audit_event_v WHERE op <> 'r' AND actor IS NOT NULL
                       GROUP BY 1 ORDER BY 2 DESC`),
    ]);
    return { ...total.rows[0], tables: tables.rows, actors: actors.rows };
  }

  /** Recent changes across everything (feed), newest first. Keyset-paginated on lsn. */
  async feed(opts: { table?: string; actor?: string; limit: number; beforeLsn?: string }) {
    const where: string[] = [`op <> 'r'`];
    const args: unknown[] = [];
    if (opts.table) { args.push(assertTable(opts.table)); where.push(`source_table = $${args.length}`); }
    if (opts.actor) { args.push(opts.actor); where.push(`actor = $${args.length}`); }
    if (opts.beforeLsn) { args.push(opts.beforeLsn); where.push(`lsn < $${args.length}`); }
    args.push(opts.limit);
    const { rows } = await this.pool.query(
      `SELECT event_id, lsn::text, source_table, pk, op, changed_fields, tx_id::text, source_ts, actor, before, after
       FROM audit_event_v WHERE ${where.join(' AND ')} ORDER BY lsn DESC, event_id LIMIT $${args.length}`, args);
    return rows.map((r) => ({ ...r, diff: diffRows(r.before, r.after) }));
  }

  /** Full timeline of one record, oldest first, each with a diff. */
  async history(table: string, id: string) {
    const { rows } = await this.pool.query(
      `SELECT event_id, lsn::text, op, tx_id::text, source_ts, actor, before, after
       FROM audit_event_v WHERE source_table = $1 AND pk = $2::jsonb ORDER BY lsn`,
      [assertTable(table), JSON.stringify({ id: Number(id) })]);
    return rows.map((r) => ({ ...r, diff: diffRows(r.before, r.after) }));
  }

  /** State of one record as of a timestamp: null if it did not exist (or was deleted) then. */
  async recordAsOf(table: string, id: string, ts: Date) {
    const { rows } = await this.pool.query(
      `SELECT op, after, lsn::text, source_ts, actor FROM audit_event_v
       WHERE source_table = $1 AND pk = $2::jsonb AND source_ts <= $3 ORDER BY lsn DESC LIMIT 1`,
      [assertTable(table), JSON.stringify({ id: Number(id) }), ts]);
    const r = rows[0];
    return { asOf: ts, exists: !!r && r.op !== 'd', row: r && r.op !== 'd' ? r.after : null, lastEvent: r ?? null };
  }

  /** Whole table as of a timestamp (the "time-travel" view). */
  async tableAsOf(table: string, ts: Date) {
    const { rows } = await this.pool.query(
      `SELECT after AS row FROM (
         SELECT DISTINCT ON (pk) pk, op, after FROM audit_event
         WHERE source_table = $1 AND source_ts <= $2 ORDER BY pk, lsn DESC
       ) s WHERE op <> 'd' ORDER BY (pk->>'id')::bigint`,
      [assertTable(table), ts]);
    return { asOf: ts, count: rows.length, rows: rows.map((r) => r.row) };
  }

  /** Everything that changed together in one transaction. */
  async transaction(txId: string) {
    const { rows } = await this.pool.query(
      `SELECT event_id, lsn::text, source_table, pk, op, source_ts, actor, before, after
       FROM audit_event_v WHERE tx_id = $1 ORDER BY lsn`, [txId]);
    return rows.map((r) => ({ ...r, diff: diffRows(r.before, r.after) }));
  }

  async onModuleDestroy() { await this.pool.end(); }
}
