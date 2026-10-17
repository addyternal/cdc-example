# Live Audit Trail with Debezium

Every insert/update/delete on a sample "shop" database is captured from the Postgres WAL by
Debezium and stored as an immutable history: who changed what, when, with before/after values.
The app being audited contains **no audit code** (only a one-line actor tag per transaction).

```
workload ─► source-db (pg16, :5433, wal_level=logical)
              │ WAL / pgoutput
              ▼
         Debezium Server ─► Redis Streams (cdc.public.*, cdc.message)
                                   │ consumer group
                                   ▼
                          writer (NestJS) ─► audit DB (cdc_audit on existing postgres :5432)
                                                   │
                                      api (NestJS :3100) ◄─ web (Next.js :3200)
```

## Reuses existing containers
- `postgres` (shared) → audit store: database `cdc_audit`, role `cdc_audit` (nothing else touched).
- `redis` (shared) → streams named `cdc.*` and `__debezium-heartbeat.cdc`.
- New: `cdc-source-db` (:5433) and `cdc-debezium`, both on `shared-network`.

## Run
```bash
npm install
docker compose up -d                 # source-db + debezium (needs shared-network, postgres, redis up)
# one-time: create the audit schema on the existing postgres
docker exec -i postgres psql -U cdc_audit -d cdc_audit < infra/audit/schema.sql

npm run writer                       # stream consumer -> audit DB
npm run api                          # audit API (read-only)        http://localhost:3100
npm run shop                         # shop API (writes to source)  http://localhost:3300
npm run web                          # UI                           http://localhost:3200
#   /shop  -> edit data (as a named actor) and watch the audit feed react
#   /      -> audit trail: history, transactions, time travel

npm run start  -w @cdc/workload -- 40 200   # generate 40 changes, 200ms apart
npm run verify -w @cdc/workload             # replay invariant (see below)
npm test                                    # unit tests
```
(The one-time `cdc_audit` role/database creation is `CREATE ROLE cdc_audit LOGIN PASSWORD 'cdc_audit_pw'; CREATE DATABASE cdc_audit OWNER cdc_audit;`.)

## Making changes from the UI (`/shop`)
Pick who you are ("Acting as"), then edit/create/delete rows or place an order. Each click is one
transaction on the source DB, tagged with that actor; the live feed on the right shows it arrive
(~1s: Postgres → Debezium → Redis → writer → audit DB). "Place order" touches 4 tables in one
transaction and is atomic (stock is checked and decremented; a failure leaves nothing behind).
The shop API only accepts allow-listed columns (`apps/shop/src/tables.ts`); values are always bound parameters.

## Design notes
- **Order by `lsn`, never timestamps.** LSN is true commit order.
- **Idempotent:** unique `(lsn, source_table, pk, op)`; redelivery is a no-op. Ack only after commit.
- **Immutable:** triggers reject UPDATE/DELETE/TRUNCATE on `audit_event`.
- **Actor:** the app calls `pg_logical_emit_message(true,'audit','{"actor":"alice"}')` inside each
  transaction. Debezium captures it; it's stored in `tx_actor` and joined at read time (`audit_event_v`)
  because messages and row events travel on different streams with no cross-stream ordering.
- **`REPLICA IDENTITY FULL`** on audited tables gives complete before-images.
- **Poison events** go to the `cdc.dlq` stream after 3 attempts.
- **Heartbeat** keeps the replication slot advancing when idle; the writer caps that stream at 100 entries.

## Verified
- Snapshot + live capture, `changed_fields`, per-transaction actor (100% of non-snapshot events).
- **Replay invariant:** folding the audit log reproduces every live table exactly (`npm run verify`).
- Drills: Debezium down during writes; writer down during writes (lag builds, then catches up);
  full redelivery (no duplicates); `ALTER TABLE ADD COLUMN` mid-stream (captured, nothing dead-lettered).
- Not verified: the web UI was type-checked and served, but not exercised in a browser.

## Known gaps / next steps
- **Table streams are not trimmed** (unbounded growth in Redis). Safe trimming needs
  `MINID` = the consumer group's last-acked ID; the audit DB is the durable record.
- `audit_event` is not partitioned yet (monthly range partitioning is the plan once volume warrants).
- Absent key vs `NULL`: after `ADD COLUMN`, older events lack the new key; consumers should treat absent as NULL.
- Dead consumer names persist in the Redis group after a crash (harmless; `XGROUP DELCONSUMER` to tidy).
- Stretch (v2): revert-a-change, PII masking (`column.mask.*`), tamper-evident hash chain.
- Dev credentials are hard-coded for local use only.
