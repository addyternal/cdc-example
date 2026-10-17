// Simulated application: performs realistic writes against the source ("shop") DB.
// The app knows nothing about auditing except that it tags each transaction with its actor
// via pg_logical_emit_message (the only app-side cooperation CDC needs).
import { Pool, PoolClient } from 'pg';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL ?? 'postgres://app:app_pw@localhost:5433/shop';
const ACTORS = ['alice', 'bob', 'carol', 'support-bot'];
const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: T[]) => xs[rnd(xs.length)];

const pool = new Pool({ connectionString: SOURCE_URL, max: 3 });

export async function asActor<T>(actor: string, fn: (c: PoolClient) => Promise<T>, meta: object = {}): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT pg_logical_emit_message(true, 'audit', $1)`, [JSON.stringify({ actor, ...meta })]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

const scenarios: Array<[string, (c: PoolClient) => Promise<unknown>]> = [
  ['adjust balance', async (c) => {
    const { rows } = await c.query('SELECT id FROM accounts ORDER BY random() LIMIT 1');
    if (rows[0]) await c.query('UPDATE accounts SET balance = balance + $2, updated_at = now() WHERE id = $1', [rows[0].id, rnd(100) - 30]);
  }],
  ['new account', async (c) => {
    const n = Date.now().toString(36) + rnd(999);
    await c.query(`INSERT INTO accounts (email, name, phone, profile) VALUES ($1,$2,$3,$4)`,
      [`user-${n}@example.com`, `User ${n}`, Math.random() < 0.5 ? null : `+1-555-${1000 + rnd(8999)}`, JSON.stringify({ tier: pick(['free', 'pro']) })]);
  }],
  ['change status / profile', async (c) => {
    const { rows } = await c.query('SELECT id FROM accounts ORDER BY random() LIMIT 1');
    if (rows[0]) await c.query(`UPDATE accounts SET status=$2, profile = profile || $3::jsonb, updated_at=now() WHERE id=$1`,
      [rows[0].id, pick(['active', 'suspended', 'active']), JSON.stringify({ tier: pick(['free', 'pro', 'enterprise']) })]);
  }],
  ['price / stock change', async (c) => {
    const { rows } = await c.query('SELECT id FROM products ORDER BY random() LIMIT 1');
    if (rows[0]) await c.query('UPDATE products SET price = GREATEST(1, price + $2), stock = GREATEST(0, stock + $3) WHERE id = $1', [rows[0].id, (rnd(11) - 5) / 2, rnd(20) - 10]);
  }],
  ['place order (multi-row tx)', async (c) => {
    const acc = (await c.query('SELECT id FROM accounts ORDER BY random() LIMIT 1')).rows[0];
    const prods = (await c.query('SELECT id, price FROM products ORDER BY random() LIMIT $1', [1 + rnd(3)])).rows;
    if (!acc || !prods.length) return;
    const order = (await c.query('INSERT INTO orders (account_id) VALUES ($1) RETURNING id', [acc.id])).rows[0];
    let total = 0;
    for (const p of prods) {
      const qty = 1 + rnd(3);
      total += qty * Number(p.price);
      await c.query('INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES ($1,$2,$3,$4)', [order.id, p.id, qty, p.price]);
    }
    await c.query('UPDATE orders SET total = $2 WHERE id = $1', [order.id, total.toFixed(2)]);
  }],
  ['advance order status', async (c) => {
    const { rows } = await c.query(`SELECT id, status FROM orders WHERE status <> 'shipped' ORDER BY random() LIMIT 1`);
    if (rows[0]) await c.query('UPDATE orders SET status=$2 WHERE id=$1', [rows[0].id, rows[0].status === 'pending' ? 'paid' : 'shipped']);
  }],
  ['cancel order (cascade delete)', async (c) => {
    const { rows } = await c.query(`SELECT id FROM orders WHERE status='pending' ORDER BY random() LIMIT 1`);
    if (rows[0]) await c.query('DELETE FROM orders WHERE id=$1', [rows[0].id]);
  }],
];

async function main() {
  const count = Number(process.argv[2] ?? 30);
  const delayMs = Number(process.argv[3] ?? 200);
  for (let i = 0; i < count; i++) {
    const [name, fn] = pick(scenarios);
    const actor = pick(ACTORS);
    await asActor(actor, fn, { scenario: name });
    console.log(`${String(i + 1).padStart(3)}/${count} ${actor.padEnd(12)} ${name}`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  await pool.end();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
