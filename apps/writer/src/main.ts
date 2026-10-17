import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function main() {
  // Standalone context: no HTTP server, just the stream consumer.
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
