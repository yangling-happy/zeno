import { Module } from '@nestjs/common';
import { AgentToolService } from './agent-tool.service';

@Module({
  providers: [AgentToolService],
  exports: [AgentToolService],
})
export class AgentToolModule {}
