import 'reflect-metadata';
import { Module, Catch, ArgumentsHost, ExceptionFilter, HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({ controllers: [AuditController], providers: [AuditService] })
class AppModule {}

// Domain errors (e.g. unknown table) -> 400 instead of a bare 500.
@Catch(Error)
class ErrorFilter implements ExceptionFilter {
  catch(e: Error, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) return res.status(e.getStatus()).json(e.getResponse());
    const bad = e.message.startsWith('unknown table');
    res.status(bad ? 400 : 500).json({ statusCode: bad ? 400 : 500, message: bad ? e.message : 'internal error' });
    if (!bad) console.error(e);
  }
}

async function main() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port);
  console.log(`audit api on http://localhost:${port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
