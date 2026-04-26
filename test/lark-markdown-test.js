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

// 测试普通文本消息
const textMessage = {
  message_id: 'test-text-message-123',
  open_id: 'test-user-123',
  content: JSON.stringify({ text: 'Hello, this is a text message' })
};

// 测试 Markdown 格式消息
const markdownMessage = {
  message_id: 'test-markdown-message-123',
  open_id: 'test-user-123',
  content: JSON.stringify({ markdown: '# Hello\nThis is a **markdown** message' })
};

// 测试函数
async function testMessageProcessing() {
  console.log('开始测试消息处理...');
  
  // 测试普通文本消息
  console.log('\n测试普通文本消息:');
  const textContent = larkService['extractText'](textMessage.content);
  console.log('提取的文本:', textContent);
  
  // 测试 Markdown 格式消息
  console.log('\n测试 Markdown 格式消息:');
  const markdownContent = larkService['extractText'](markdownMessage.content);
  console.log('提取的文本:', markdownContent);
  
  // 测试消息处理
  console.log('\n测试消息处理流程:');
  await larkService['processMessage'](markdownMessage, markdownContent);
  
  console.log('\n测试完成');
}

// 运行测试
testMessageProcessing()
  .then(() => console.log('测试成功完成'))
  .catch(err => console.error('测试失败:', err));
