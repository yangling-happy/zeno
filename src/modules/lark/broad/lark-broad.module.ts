import { Module } from '@nestjs/common';
import { LarkDocModule } from '../doc/lark-doc.module';
import { LarkBroadService } from './lark-broad.service';

@Module({
  imports: [LarkDocModule],
  providers: [LarkBroadService],
  exports: [LarkBroadService],
})
export class LarkBroadModule {}
