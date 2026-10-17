import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post } from '@nestjs/common';
import { ShopService } from './shop.service';
import { TABLES } from './tables';

function id(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new BadRequestException('id must be a positive integer');
  return n;
}

@Controller()
export class ShopController {
  constructor(@Inject(ShopService) private readonly svc: ShopService) {}

  /** Editable columns per table, so the UI is driven by the same allow-list the server enforces. */
  @Get('meta')
  meta() { return TABLES; }

  @Get('tables/:table')
  list(@Param('table') table: string) { return this.svc.list(table); }

  @Post('tables/:table')
  create(@Param('table') table: string, @Body() b: { actor?: unknown; values?: unknown }) {
    return this.svc.create(table, b?.actor, b?.values);
  }

  @Patch('tables/:table/:id')
  update(@Param('table') table: string, @Param('id') i: string, @Body() b: { actor?: unknown; values?: unknown }) {
    return this.svc.update(table, id(i), b?.actor, b?.values);
  }

  @Delete('tables/:table/:id')
  remove(@Param('table') table: string, @Param('id') i: string, @Body() b: { actor?: unknown }) {
    return this.svc.remove(table, id(i), b?.actor);
  }

  @Post('orders/place')
  place(@Body() b: { actor?: unknown; accountId?: unknown; items?: unknown }) {
    return this.svc.placeOrder(b?.actor, b?.accountId, b?.items);
  }
}
