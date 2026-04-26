import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { startOtel, shutdownOtel } from './opentelemetry';

async function bootstrap() {
  // 启动 OpenTelemetry
  await startOtel();
  
  const app = await NestFactory.create(AppModule);
  
  // 优雅关闭
  app.enableShutdownHooks();
  
  await app.listen(process.env.PORT ?? 3000);
}

// 启动应用
bootstrap().catch(async (error) => {
  console.error('应用启动失败:', error);
  await shutdownOtel();
  process.exit(1);
});
