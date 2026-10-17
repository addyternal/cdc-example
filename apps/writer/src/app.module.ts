import { Module } from '@nestjs/common';
import { ConsumerService } from './consumer.service';
import { DbService } from './db.service';

@Module({ providers: [DbService, ConsumerService] })
export class AppModule {}
