import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
// 1. 修改导入：引入 resourceFromAttributes 工厂函数
import { Resource, resourceFromAttributes } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// OpenTelemetry 配置
const otelSDK = new NodeSDK({
  // 2. 修改实例化方式：使用 resourceFromAttributes 替代 new Resource()
  resource: resourceFromAttributes({
    [SemanticResourceAttributes.SERVICE_NAME]: 'zeno-agent',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: new JaegerExporter({
    endpoint: 'http://localhost:14268/api/traces',
  }),
  instrumentations: getNodeAutoInstrumentations(),
});

// 启动 OpenTelemetry SDK
async function startOtel() {
  try {
    await otelSDK.start();
    console.log('OpenTelemetry 已启动');
  } catch (error) {
    console.error('OpenTelemetry 启动失败:', error);
  }
}

// 关闭 OpenTelemetry SDK
async function shutdownOtel() {
  try {
    await otelSDK.shutdown();
    console.log('OpenTelemetry 已关闭');
  } catch (error) {
    console.error('OpenTelemetry 关闭失败:', error);
  }
}

export { startOtel, shutdownOtel };
