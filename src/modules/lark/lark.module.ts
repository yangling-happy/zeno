import { Module, forwardRef } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { SessionModule } from '../agent/session/session.module';
import { CommonModule } from '../common/common.module';
import { MemoryModule } from '../memory/memory.module';
import { QueueModule } from '../queue/queue.module';
import { LarkActionExecutorService } from './lark-action-executor.service';
import { LarkBroadModule } from './broad/lark-broad.module';
import { LarkDocModule } from './doc/lark-doc.module';
import { LarkReplyService } from './lark-reply.service';
import { LarkService } from './lark.service';
import { LarkSlidesModule } from './slides/lark-slides.module';

@Module({
  imports: [
    AgentModule,
    SessionModule,
    CommonModule,
    MemoryModule,
    forwardRef(() => QueueModule),
    LarkDocModule,
    LarkSlidesModule,
    LarkBroadModule,
  ],
  providers: [LarkService, LarkActionExecutorService, LarkReplyService],
  exports: [LarkService],
})
export class LarkModule {}
