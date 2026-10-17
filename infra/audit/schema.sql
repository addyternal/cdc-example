-- Audit store (database: cdc_audit). Append-only history of every captured change.

CREATE TABLE IF NOT EXISTS audit_event (
  event_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lsn            bigint      NOT NULL,          -- true commit order; never order by timestamp
  source_table   text        NOT NULL,
  pk             jsonb       NOT NULL,
  op             char(1)     NOT NULL CHECK (op IN ('r','c','u','d')),
  before         jsonb,
  after          jsonb,
  changed_fields text[]      NOT NULL DEFAULT '{}',
  tx_id          bigint,
  source_ts      timestamptz NOT NULL,
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: a redelivered event is a no-op.
  CONSTRAINT audit_event_dedupe UNIQUE (lsn, source_table, pk, op)
);

CREATE INDEX IF NOT EXISTS audit_event_row_idx ON audit_event (source_table, pk, lsn);
CREATE INDEX IF NOT EXISTS audit_event_tx_idx  ON audit_event (tx_id, lsn);
CREATE INDEX IF NOT EXISTS audit_event_ts_idx  ON audit_event (source_ts);

-- Actor per transaction, captured from pg_logical_emit_message('audit', ...).
-- Kept separate (and joined at read time) because messages and row events travel
-- on different streams, so their arrival order is not guaranteed.
CREATE TABLE IF NOT EXISTS tx_actor (
  tx_id  bigint NOT NULL,
  lsn    bigint NOT NULL,
  actor  text,
  meta   jsonb  NOT NULL DEFAULT '{}',
  PRIMARY KEY (tx_id, lsn)
);

-- Immutability: history can be appended to, never changed.
CREATE OR REPLACE FUNCTION audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% blocked)', TG_OP;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_event_no_mutate ON audit_event;
CREATE TRIGGER audit_event_no_mutate
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();

DROP TRIGGER IF EXISTS audit_event_no_truncate ON audit_event;
CREATE TRIGGER audit_event_no_truncate
  BEFORE TRUNCATE ON audit_event
  FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();

-- Events with the actor resolved: latest actor message in the same tx at or before the event.
CREATE OR REPLACE VIEW audit_event_v AS
SELECT e.*, a.actor
FROM audit_event e
LEFT JOIN LATERAL (
  SELECT t.actor FROM tx_actor t
  WHERE t.tx_id = e.tx_id AND t.lsn <= e.lsn
  ORDER BY t.lsn DESC LIMIT 1
) a ON true;
