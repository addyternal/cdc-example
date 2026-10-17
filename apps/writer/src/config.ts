export const config = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  auditDbUrl: process.env.AUDIT_DATABASE_URL ?? 'postgres://cdc_audit:cdc_audit_pw@localhost:5432/cdc_audit',
  group: process.env.CDC_GROUP ?? 'audit-writer',
  consumer: process.env.CDC_CONSUMER ?? `writer-${process.pid}`,
  dlqStream: 'cdc.dlq',
  maxAttempts: 3,
  // Table change streams are named <topic.prefix>.<schema>.<table> by Debezium Server.
  tableStreams: ['accounts', 'products', 'orders', 'order_items'].map((t) => `cdc.public.${t}`),
  messageStream: 'cdc.message',
  heartbeatStream: '__debezium-heartbeat.cdc',
};
