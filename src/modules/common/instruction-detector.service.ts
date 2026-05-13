import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { detectRequestNature, isLikelyActionRequest } from './agent.utils';

@Injectable()
export class InstructionDetectorService {
  private readonly logger = new Logger(InstructionDetectorService.name);

  constructor(private readonly aiService: AiService) {}

  async isInstruction(text: string): Promise<boolean> {
    const trimmedText = text.trim();

    const requestNature = detectRequestNature(trimmedText);

    if (!isLikelyActionRequest(trimmedText)) {
      this.logger.debug(
        `非执行请求，跳过指令检测: action=${requestNature.matchedActionPhrases.join('、') || '无'}, consult=${requestNature.matchedConsultativePhrases.join('、') || '无'}, domain=${requestNature.matchedDomainPhrases.join('、') || '无'}`,
      );
      return false;
    }

    if (requestNature.isActionRequest) {
      try {
        const prompt = `判断以下文本是否为明确的执行请求（需要生成、创建、修改、追加、整理内容），而不是咨询、建议、解释或闲聊。只需返回 true 或 false：\n"${trimmedText}"`;
        const response = await this.aiService.chat(prompt);
        return response.trim().toLowerCase() === 'true';
      } catch (error) {
        this.logger.warn(
          `指令检测失败，使用关键词规则: ${(error as Error).message}`,
        );
        return true;
      }
    }

    return false;
  }

  async processInstruction(
    instruction: string,
    context?: string,
  ): Promise<string> {
    this.logger.log(`处理指令: ${instruction}`);
    try {
      let prompt = `根据以下指令生成完整内容：\n"${instruction}"`;

      if (context) {
        prompt = `用户希望完善或补充以下内容：\n背景：${context}\n\n指令：${instruction}\n\n请生成符合上下文语境的内容来执行该指令。`;
      }

      const response = await this.aiService.chat(prompt);
      this.logger.log(`指令处理完成，生成内容长度: ${response.length}`);
      return response;
    } catch (error) {
      this.logger.error(`指令处理失败: ${(error as Error).message}`);
      return `抱歉，无法处理该指令。错误信息：${(error as Error).message}`;
    }
  }

  async generateDocumentMarkdown(
    instruction: string,
    context?: string,
  ): Promise<string> {
    this.logger.log(`doc_generation_started: ${instruction}`);

    let prompt = `根据以下指令生成完整文档正文，直接输出 Markdown 正文内容：\n"${instruction}"`;

    if (context) {
      prompt = `用户希望生成一篇完整文档正文。\n背景：${context}\n\n指令：${instruction}\n\n请直接输出可写入飞书文档的 Markdown 正文，不要输出致歉、失败说明、额外解释或围绕任务的对话。`;
    }

    const response = await this.aiService.generateDocumentMarkdown(prompt);
    const normalized = response.trim();

    if (!normalized) {
      this.logger.error('doc_generation_failed: empty markdown content');
      throw new Error('文档正文生成为空');
    }

    const invalidPrefixes = ['抱歉', '无法处理', '系统暂时', '错误信息'];
    if (invalidPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      this.logger.error('doc_generation_failed: invalid fallback-like content');
      throw new Error('文档正文生成结果无效');
    }

    this.logger.log(`指令处理完成，文档正文长度: ${normalized.length}`);
    return normalized;
  }
}
