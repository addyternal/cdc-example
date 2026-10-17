import { BadRequestException, Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { AuditService } from './audit.service';

function parseTs(v?: string): Date {
  const d = v ? new Date(v) : new Date();
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`invalid timestamp: ${v}`);
  return d;
}

@Controller()
export class AuditController {
  constructor(@Inject(AuditService) private readonly svc: AuditService) {}

  @Get('stats')
  stats() { return this.svc.stats(); }

  @Get('events')
  feed(@Query('table') table?: string, @Query('actor') actor?: string,
       @Query('limit') limit = '50', @Query('beforeLsn') beforeLsn?: string) {
    if (beforeLsn && !/^\d+$/.test(beforeLsn)) throw new BadRequestException('beforeLsn must be numeric');
    return this.svc.feed({ table, actor, limit: Math.min(Math.max(Number(limit) || 50, 1), 200), beforeLsn });
  }

  @Get('records/:table/:id/history')
  history(@Param('table') table: string, @Param('id') id: string) { return this.svc.history(table, id); }

  @Get('records/:table/:id/as-of')
  recordAsOf(@Param('table') table: string, @Param('id') id: string, @Query('ts') ts?: string) {
    return this.svc.recordAsOf(table, id, parseTs(ts));
  }

  @Get('tables/:table/as-of')
  tableAsOf(@Param('table') table: string, @Query('ts') ts?: string) {
    return this.svc.tableAsOf(table, parseTs(ts));
  }

  @Get('transactions/:txId')
  tx(@Param('txId') txId: string) {
    if (!/^\d+$/.test(txId)) throw new BadRequestException('txId must be numeric');
    return this.svc.transaction(txId);
  }
}
