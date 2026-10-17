import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { config } from './config';
import type { AuditRow, TxActorRow } from './transform';

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly pool = new Pool({ connectionString: config.auditDbUrl, max: 4 });

  /** Idempotent: a redelivered event hits the unique constraint and is skipped. Returns true if inserted. */
  async insertEvent(r: AuditRow): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO audit_event
         (lsn, source_table, pk, op, before, after, changed_fields, tx_id, source_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT ON CONSTRAINT audit_event_dedupe DO NOTHING`,
      [r.lsn, r.sourceTable, r.pk, r.op, r.before, r.after, r.changedFields, r.txId, r.sourceTs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async insertTxActor(a: TxActorRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO tx_actor (tx_id, lsn, actor, meta) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tx_id, lsn) DO NOTHING`,
      [a.txId, a.lsn, a.actor, a.meta],
    );
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
