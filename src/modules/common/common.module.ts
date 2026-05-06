import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { InstructionDetectorService } from './instruction-detector.service';

@Module({
  imports: [AiModule],
  providers: [InstructionDetectorService],
  exports: [InstructionDetectorService],
})
export class CommonModule {}
