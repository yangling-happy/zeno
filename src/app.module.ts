import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LarkModule } from './modules/lark/lark.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), LarkModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
