import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiService } from './modules/ai/ai.service';
import { AgentService } from './modules/agent/agent.service';
import { AgentToolService } from './modules/agent/agent-tool.service';
import { SessionService } from './modules/agent/session/session.service';
import { CacheService } from './modules/agent/cache.service';
import { LarkService } from './modules/lark/lark.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [AppController],
  providers: [
    AppService,
    LarkService,
    AiService,
    AgentService,
    AgentToolService,
    SessionService,
    CacheService,
  ],
})
export class AppModule {}
