import { Global, Module, forwardRef } from '@nestjs/common';
import { LarkModule } from '../lark/lark.module';
import { LarkMessageQueue } from './lark-message.queue';
import { LarkMessageWorker } from './lark-message.worker';

@Global()
@Module({
  imports: [forwardRef(() => LarkModule)],
  providers: [LarkMessageQueue, LarkMessageWorker],
  exports: [LarkMessageQueue],
})
export class QueueModule {}
