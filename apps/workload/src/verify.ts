// Invariant check: folding the audit log must reproduce every live source table exactly.
// If this holds, the audit trail is complete and correct (nothing lost, nothing invented).
import { Pool } from 'pg';
import { isDeepStrictEqual } from 'node:util';

const source = new Pool({ connectionString: process.env.SOURCE_DATABASE_URL ?? 'postgres://app:app_pw@localhost:5433/shop' });
const audit = new Pool({ connectionString: process.env.AUDIT_DATABASE_URL ?? 'postgres://cdc_audit:cdc_audit_pw@localhost:5432/cdc_audit' });

const TABLES = ['accounts', 'products', 'orders', 'order_items'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const NUM = /^-?\d+(\.\d+)?$/;

// Source (row_to_json) and Debezium encode numerics/timestamps differently; normalise both.
function norm(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (ISO.test(v)) return new Date(v).getTime();
    if (NUM.test(v)) return Number(v);
    return v;
  }
  if (Array.isArray(v)) return v.map(norm);
  // Absent key == NULL: after ALTER TABLE ADD COLUMN, rows untouched since then have no key in
  // their last event, while the live table reports the new column as NULL. Same logical state.
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as object).map(([k, x]) => [k, norm(x)]).filter(([, x]) => x !== null).sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  }
  return v;
}

async function lagSettled(): Promise<void> {
  // Wait until the audit log stops growing (pipeline drained).
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const n = Number((await audit.query('SELECT count(*) FROM audit_event')).rows[0].count);
    stable = n === last ? stable + 1 : 0;
    last = n;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  await lagSettled();
  let ok = true;
  for (const t of TABLES) {
    const live = (await source.query(`SELECT row_to_json(t) AS r FROM ${t} t`)).rows.map((x) => norm(x.r));
    const rebuilt = (await audit.query(
      `SELECT after AS r FROM (
         SELECT DISTINCT ON (pk) pk, op, after FROM audit_event WHERE source_table = $1 ORDER BY pk, lsn DESC
       ) s WHERE op <> 'd'`, [t])).rows.map((x) => norm(x.r));
    const key = (r: any) => String(r.id).padStart(12, '0');
    live.sort((a: any, b: any) => key(a).localeCompare(key(b)));
    rebuilt.sort((a: any, b: any) => key(a).localeCompare(key(b)));
    const same = isDeepStrictEqual(live, rebuilt);
    ok &&= same;
    console.log(`${same ? 'OK  ' : 'FAIL'} ${t.padEnd(12)} live=${live.length} rebuilt=${rebuilt.length}`);
    if (!same) {
      const L = new Map(live.map((r: any) => [r.id, JSON.stringify(r)]));
      const R = new Map(rebuilt.map((r: any) => [r.id, JSON.stringify(r)]));
      for (const id of new Set([...L.keys(), ...R.keys()])) if (L.get(id) !== R.get(id)) console.log(`  id=${id}\n   live:    ${L.get(id)}\n   rebuilt: ${R.get(id)}`);
    }
  }
  await source.end(); await audit.end();
  console.log(ok ? '\nINVARIANT HOLDS: audit log reproduces live state' : '\nINVARIANT VIOLATED');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
