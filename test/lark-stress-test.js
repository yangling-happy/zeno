const { LarkService } = require('../dist/modules/lark/lark.service');
const { ConfigService } = require('@nestjs/config');

// 模拟 ConfigService
class MockConfigService {
  get(key) {
    // 这里可以设置测试用的配置
    return '';
  }
}

// 模拟 AgentService
class MockAgentService {
  async run(data) {
    // 模拟处理延迟
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      intent: 'test',
      confidence: 0.9,
      response: 'Test response',
      actionInstruction: null
    };
  }
}

// 创建 LarkService 实例
const configService = new MockConfigService();
const agentService = new MockAgentService();
const larkService = new LarkService(configService, agentService);

// 模拟消息数据
const mockMessage = {
  message_id: 'test-message-123',
  open_id: 'test-user-123',
  content: JSON.stringify({ text: 'Test message' })
};

// 压力测试函数
async function stressTest() {
  console.log('开始压力测试...');
  const startTime = Date.now();
  const messageCount = 100;
  const promises = [];

  // 并发处理消息
  for (let i = 0; i < messageCount; i++) {
    const message = {
      ...mockMessage,
      message_id: `test-message-${i}`
    };
    promises.push(larkService['processMessage'](message, `Test message ${i}`));
  }

  // 等待所有消息处理完成
  await Promise.all(promises);
  const endTime = Date.now();
  const duration = endTime - startTime;

  console.log(`压力测试完成`);
  console.log(`处理消息数: ${messageCount}`);
  console.log(`总耗时: ${duration}ms`);
  console.log(`平均处理时间: ${duration / messageCount}ms`);
}

// 运行压力测试
stressTest()
  .then(() => console.log('压力测试成功完成'))
  .catch(err => console.error('压力测试失败:', err));
