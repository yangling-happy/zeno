import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { SessionModule } from '../agent/session/session.module';
import { CommonModule } from '../common/common.module';
import { MemoryModule } from '../memory/memory.module';
import { LarkBroadModule } from './broad/lark-broad.module';
import { LarkDocModule } from './doc/lark-doc.module';
import { LarkService } from './lark.service';
import { LarkSlidesModule } from './slides/lark-slides.module';

@Module({
  imports: [
    AgentModule,
    SessionModule,
    CommonModule,
    MemoryModule,
    LarkDocModule,
    LarkSlidesModule,
    LarkBroadModule,
  ],
  providers: [LarkService],
  exports: [LarkService],
})
export class LarkModule {}
