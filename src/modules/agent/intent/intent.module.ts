import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiModule } from '../../ai/ai.module';
import { CacheModule } from '../cache/cache.module';
import { IntentRoutingService } from './intent-routing.service';
import { IntentTransformerService } from './intent-transformer.service';
import { IntentService } from './intent.service';

@Module({
  imports: [ConfigModule, AiModule, CacheModule],
  providers: [IntentRoutingService, IntentTransformerService, IntentService],
  exports: [IntentRoutingService, IntentTransformerService, IntentService],
})
export class IntentModule {}
