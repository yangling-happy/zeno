import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AgentService } from './agent.service';
import { CacheModule } from './cache/cache.module';
import { AgentToolModule } from './tool/agent-tool.module';
import { IntentModule } from './intent/intent.module';
import { SessionModule } from './session/session.module';
import { AgentGraphService } from './agent-graph.service';
import { SceneReplyService } from './scene-reply.service';

@Module({
  imports: [
    AiModule,
    IntentModule,
    SessionModule,
    CacheModule,
    AgentToolModule,
  ],
  providers: [AgentService, AgentGraphService, SceneReplyService],
  exports: [AgentService],
})
export class AgentModule {}
