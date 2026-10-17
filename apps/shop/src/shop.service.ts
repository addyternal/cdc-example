import { ConflictException, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { parseActor, sanitize, spec, ValidationError } from './tables';

const SOURCE_URL = process.env.SOURCE_DATABASE_URL ?? 'postgres://app:app_pw@localhost:5433/shop';

export interface Result<T = unknown> { row?: T; txId: string }

@Injectable()
export class ShopService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: SOURCE_URL, max: 5 });

  /**
   * One user action = one transaction, tagged with the actor via a logical-decoding message.
   * That tag is all the auditing the application does; Debezium captures the rest from the WAL.
   */
  private async tx<T>(actor: unknown, action: string, fn: (c: PoolClient) => Promise<T>): Promise<{ out: T; txId: string }> {
    const who = parseActor(actor);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_logical_emit_message(true, 'audit', $1)`, [JSON.stringify({ actor: who, source: 'shop-ui', action })]);
      const out = await fn(c);
      // 32-bit xid, the same id Debezium reports as source.txId, so the UI can link to the audit transaction.
      const txId = (await c.query(`SELECT pg_current_xact_id()::xid::text AS id`)).rows[0].id as string;
      await c.query('COMMIT');
      return { out, txId };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw this.translate(e);
    } finally {
      c.release();
    }
  }

  private translate(e: unknown): unknown {
    const code = (e as { code?: string }).code;
    if (code === '23503') return new ConflictException('Blocked by a related record (foreign key). Delete or change the related rows first.');
    if (code === '23505') return new ConflictException('A row with that unique value already exists.');
    if (code === '23502') return new ValidationError('A required value is missing.');
    if (code === '22P02' || code === '22003' || code === '23514') return new ValidationError('A value has the wrong format or is out of range.');
    return e;
  }

  async list(table: string) {
    spec(table);
    const { rows } = await this.pool.query(`SELECT * FROM ${table} ORDER BY id`); // table is allow-listed by spec()
    return rows;
  }

  async create(table: string, actor: unknown, values: unknown): Promise<Result> {
    const { columns, params } = sanitize(table, values, 'create');
    const cols = columns.map((c) => `"${c}"`).join(', ');
    const ph = columns.map((_, i) => `$${i + 1}`).join(', ');
    const { out, txId } = await this.tx(actor, `create ${table}`, async (c) =>
      (await c.query(`INSERT INTO ${table} (${cols}) VALUES (${ph}) RETURNING *`, params)).rows[0]);
    return { row: out, txId };
  }

  async update(table: string, id: number, actor: unknown, values: unknown): Promise<Result> {
    const { columns, params, spec: s } = sanitize(table, values, 'update');
    const sets = columns.map((c, i) => `"${c}" = $${i + 1}`);
    if (s.touch) sets.push(`"${s.touch}" = now()`);
    const { out, txId } = await this.tx(actor, `update ${table} #${id}`, async (c) =>
      (await c.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${columns.length + 1} RETURNING *`, [...params, id])).rows[0]);
    if (!out) throw new NotFoundException(`${table} #${id} not found`);
    return { row: out, txId };
  }

  async remove(table: string, id: number, actor: unknown): Promise<Result> {
    spec(table);
    const { out, txId } = await this.tx(actor, `delete ${table} #${id}`, async (c) =>
      (await c.query(`DELETE FROM ${table} WHERE id = $1 RETURNING id`, [id])).rows[0]);
    if (!out) throw new NotFoundException(`${table} #${id} not found`);
    return { txId };
  }

  /** Multi-row business transaction: order + items + stock decrement + total, atomically. */
  async placeOrder(actor: unknown, accountId: unknown, items: unknown): Promise<Result> {
    const acc = Number(accountId);
    if (!Number.isInteger(acc) || acc < 1) throw new ValidationError('accountId must be a valid id');
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) throw new ValidationError('items must be a list of 1-20 entries');
    const lines = items.map((i: any) => {
      const productId = Number(i?.productId), qty = Number(i?.qty);
      if (!Number.isInteger(productId) || productId < 1) throw new ValidationError('each item needs a valid productId');
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) throw new ValidationError('qty must be a whole number from 1 to 100');
      return { productId, qty };
    });
    if (new Set(lines.map((l) => l.productId)).size !== lines.length) throw new ValidationError('each product may appear only once');

    const { out, txId } = await this.tx(actor, `place order for account #${acc}`, async (c) => {
      const order = (await c.query('INSERT INTO orders (account_id) VALUES ($1) RETURNING id', [acc])).rows[0];
      let total = 0;
      for (const l of lines) {
        // Lock the product row so concurrent orders can't oversell.
        const p = (await c.query('SELECT price, stock, name FROM products WHERE id = $1 FOR UPDATE', [l.productId])).rows[0];
        if (!p) throw new NotFoundException(`product #${l.productId} not found`);
        if (p.stock < l.qty) throw new ConflictException(`Not enough stock for ${p.name} (have ${p.stock}, need ${l.qty})`);
        await c.query('INSERT INTO order_items (order_id, product_id, qty, unit_price) VALUES ($1,$2,$3,$4)', [order.id, l.productId, l.qty, p.price]);
        await c.query('UPDATE products SET stock = stock - $2 WHERE id = $1', [l.productId, l.qty]);
        total += l.qty * Number(p.price);
      }
      return (await c.query('UPDATE orders SET total = $2 WHERE id = $1 RETURNING *', [order.id, total.toFixed(2)])).rows[0];
    });
    return { row: out, txId };
  }

  async onModuleDestroy() { await this.pool.end(); }
}
