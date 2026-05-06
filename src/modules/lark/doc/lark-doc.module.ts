import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { LarkDocWriterService } from './lark-doc-writer.service';
import { LarkDocService } from './lark-doc.service';

@Module({
  imports: [CommonModule],
  providers: [LarkDocWriterService, LarkDocService],
  exports: [LarkDocService],
})
export class LarkDocModule {}
