import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from './config';
import { DbService } from './db.service';
import { toAuditRow, toTxActor } from './transform';

type Entry = [id: string, fields: string[]];
type Batch = [stream: string, entries: Entry[]][];

@Injectable()
export class ConsumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ConsumerService.name);
  // Blocking reads need their own connection; `cmd` is used for ack/dlq.
  private readonly reader = new Redis(config.redisUrl);
  private readonly cmd = new Redis(config.redisUrl);
  private readonly attempts = new Map<string, number>();
  private running = true;
  private loop?: Promise<void>;
  private trimTimer?: NodeJS.Timeout;

  constructor(@Inject(DbService) private readonly db: DbService) {}

  async onApplicationBootstrap() {
    const streams = [...config.tableStreams, config.messageStream];
    for (const s of streams) {
      try {
        // "0" => on first run, process the full history incl. the initial snapshot.
        await this.cmd.xgroup('CREATE', s, config.group, '0', 'MKSTREAM');
      } catch (e) {
        if (!String(e).includes('BUSYGROUP')) throw e;
      }
    }
    this.loop = this.run(streams);
    // Nothing consumes Debezium's heartbeat stream; cap it so it can't grow unbounded in shared Redis.
    // (Table streams are intentionally NOT trimmed: a stopped writer would lose unread events.)
    const trim = () => this.cmd.xtrim(config.heartbeatStream, 'MAXLEN', 100).catch(() => undefined);
    void trim();
    this.trimTimer = setInterval(trim, 60_000);
    this.log.log(`consuming ${streams.join(', ')} as ${config.group}/${config.consumer}`);
  }

  private async run(streams: string[]) {
    // First drain our own pending (delivered but un-acked) entries, then switch to new ones.
    let id = '0';
    while (this.running) {
      try {
        const res = (await this.reader.call(
          'XREADGROUP', 'GROUP', config.group, config.consumer,
          'COUNT', '100', 'BLOCK', '2000',
          'STREAMS', ...streams, ...streams.map(() => id),
        )) as Batch | null;

        if (!res) {
          if (id === '0') id = '>';
          continue;
        }
        let handled = 0;
        for (const [stream, entries] of res) {
          for (const entry of entries) {
            await this.process(stream, entry);
            handled++;
          }
        }
        if (id === '0' && handled === 0) id = '>';
      } catch (e) {
        if (!this.running) return;
        this.log.error(`read loop error: ${e}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async process(stream: string, [entryId, fields]: Entry): Promise<void> {
    const [keyJson, valueJson] = fields;
    try {
      if (stream === config.messageStream) {
        const actor = toTxActor(valueJson);
        if (actor) await this.db.insertTxActor(actor);
      } else if (valueJson) {
        // Tombstones/empty values are skipped (tombstones.on.delete=false makes them rare).
        const inserted = await this.db.insertEvent(toAuditRow(keyJson, valueJson));
        if (!inserted) this.log.debug(`duplicate ${stream} ${entryId} ignored`);
      }
      await this.cmd.xack(stream, config.group, entryId);
      this.attempts.delete(entryId);
    } catch (e) {
      const n = (this.attempts.get(entryId) ?? 0) + 1;
      if (n < config.maxAttempts) {
        this.attempts.set(entryId, n);
        this.log.warn(`attempt ${n}/${config.maxAttempts} failed for ${stream} ${entryId}: ${e}`);
        await new Promise((r) => setTimeout(r, 250 * n));
        return this.process(stream, [entryId, fields]);
      }
      // Poison event: park it on the DLQ so the pipeline keeps moving.
      await this.cmd.xadd(config.dlqStream, '*', 'stream', stream, 'id', entryId, 'error', String(e), 'key', keyJson ?? '', 'value', valueJson ?? '');
      await this.cmd.xack(stream, config.group, entryId);
      this.attempts.delete(entryId);
      this.log.error(`moved ${stream} ${entryId} to ${config.dlqStream}: ${e}`);
    }
  }

  async onModuleDestroy() {
    this.running = false;
    clearInterval(this.trimTimer);
    this.reader.disconnect();
    await this.loop?.catch(() => undefined);
    this.cmd.disconnect();
  }
}
