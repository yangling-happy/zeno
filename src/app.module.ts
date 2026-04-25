import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LarkService } from './lark.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }), // 全局加载 .env
  ],
  providers: [LarkService],
})
export class AppModule {}
