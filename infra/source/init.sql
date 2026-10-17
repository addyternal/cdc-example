-- Source ("shop") database: the thing being audited.

CREATE TABLE accounts (
  id          bigserial PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  balance     numeric(12,2) NOT NULL DEFAULT 0,
  profile     jsonb NOT NULL DEFAULT '{}',
  phone       text,                       -- nullable: exercises null handling / PII masking
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id     bigserial PRIMARY KEY,
  sku    text UNIQUE NOT NULL,
  name   text NOT NULL,
  price  numeric(12,2) NOT NULL,
  stock  integer NOT NULL DEFAULT 0,
  attrs  jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE orders (
  id          bigserial PRIMARY KEY,
  account_id  bigint NOT NULL REFERENCES accounts(id),
  status      text NOT NULL DEFAULT 'pending',
  total       numeric(12,2) NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id          bigserial PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  bigint NOT NULL REFERENCES products(id),
  qty         integer NOT NULL,
  unit_price  numeric(12,2) NOT NULL
);

-- Full before-images on UPDATE/DELETE (also avoids TOAST placeholders).
ALTER TABLE accounts    REPLICA IDENTITY FULL;
ALTER TABLE products    REPLICA IDENTITY FULL;
ALTER TABLE orders      REPLICA IDENTITY FULL;
ALTER TABLE order_items REPLICA IDENTITY FULL;

-- Heartbeat table keeps the replication slot advancing when the app is idle.
CREATE TABLE heartbeat (id int PRIMARY KEY, ts timestamptz NOT NULL);
INSERT INTO heartbeat VALUES (1, now());

-- Debezium role + publication.
CREATE ROLE debezium WITH REPLICATION LOGIN PASSWORD 'debezium_pw';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium;
GRANT UPDATE ON heartbeat TO debezium;
CREATE PUBLICATION cdc_pub FOR TABLE accounts, products, orders, order_items, heartbeat;

-- Seed data (captured as snapshot "r" events).
INSERT INTO accounts (email, name, balance, phone) VALUES
  ('ada@example.com',   'Ada Lovelace',  120.00, '+1-555-0101'),
  ('alan@example.com',  'Alan Turing',    80.50, NULL),
  ('grace@example.com', 'Grace Hopper',  300.00, '+1-555-0103');

INSERT INTO products (sku, name, price, stock, attrs) VALUES
  ('KB-001', 'Mechanical Keyboard', 89.99, 40, '{"layout":"ansi"}'),
  ('MS-002', 'Wireless Mouse',      29.50, 120, '{"dpi":1600}'),
  ('MN-003', '27" Monitor',        249.00, 15, '{"panel":"ips"}');
