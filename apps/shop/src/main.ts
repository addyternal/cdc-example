import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';
import { ValidationError } from './tables';

@Module({ controllers: [ShopController], providers: [ShopService] })
class AppModule {}

// Validation problems -> 400 with the message; known HTTP errors pass through; the rest -> opaque 500.
@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) return res.status(e.getStatus()).json(e.getResponse());
    if (e instanceof ValidationError) return res.status(400).json({ statusCode: 400, message: e.message });
    console.error(e);
    res.status(500).json({ statusCode: 500, message: 'internal error' });
  }
}

async function main() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 3300);
  await app.listen(port);
  console.log(`shop api on http://localhost:${port}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
