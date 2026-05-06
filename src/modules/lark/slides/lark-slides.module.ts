import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { LarkSlidesService } from './lark-slides.service';

@Module({
  imports: [CommonModule],
  providers: [LarkSlidesService],
  exports: [LarkSlidesService],
})
export class LarkSlidesModule {}
