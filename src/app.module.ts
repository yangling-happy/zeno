import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AiService } from './modules/ai/ai.service';
import { AgentService } from './modules/agent/agent.service';
import { LarkService } from './modules/lark/lark.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // 全局加载 .env
  ],
  controllers: [AppController],
  providers: [AppService, LarkService, AiService, AgentService],
})
export class AppModule {}
