import {
  IntentType,
  SkillDefinition,
  SkillId,
  SkillMatch,
  SkillExecutionPlan,
} from '../agent.types';

export const SKILL_REGISTRY: Record<SkillId, SkillDefinition> = {
  'planning.skill': {
    id: 'planning.skill',
    intent: 'SCENE_PLAN',
    domainGoal: '将目标拆解为可执行计划',
    boundedContext: 'Planning',
    triggerHints: ['计划', '拆解', '安排', '路线图', '里程碑'],
    antiPatterns: ['纯闲聊', '身份问答'],
    requiredParams: [],
    optionalParams: ['goal', 'deadline', 'priority'],
    confidenceThreshold: 0.6,
    riskLevel: 'low',
    fallbackIntent: 'CLARIFY',
  },
  'documentation.skill': {
    id: 'documentation.skill',
    intent: 'SCENE_DOC',
    domainGoal: '创建或编辑文档内容',
    boundedContext: 'Documentation',
    triggerHints: ['文档', '写作', '整理', '纪要', '提纲'],
    antiPatterns: [
      '设备同步',
      '怎么写',
      '如何写',
      '有什么建议',
      '注意事项',
      '最佳实践',
    ],
    requiredParams: [],
    optionalParams: ['docTitle', 'summary'],
    confidenceThreshold: 0.62,
    riskLevel: 'medium',
    fallbackIntent: 'CLARIFY',
  },
  'presentation.skill': {
    id: 'presentation.skill',
    intent: 'SCENE_PRESENT',
    domainGoal: '生成演示稿或写入画布',
    boundedContext: 'Presentation/Whiteboard',
    triggerHints: ['演示', 'PPT', '画布', '流程图', '汇报'],
    antiPatterns: ['身份问答', '怎么做', '如何做', '有什么建议', '注意事项'],
    requiredParams: [],
    optionalParams: ['presentTitle', 'summary', 'whiteboardId'],
    confidenceThreshold: 0.65,
    riskLevel: 'medium',
    fallbackIntent: 'CLARIFY',
  },
  'sync.skill': {
    id: 'sync.skill',
    intent: 'SCENE_SYNC',
    domainGoal: '触发跨端同步或状态切换',
    boundedContext: 'Sync',
    triggerHints: ['同步', '跨端', '设备', '切换'],
    antiPatterns: ['纯文档编辑'],
    requiredParams: [],
    optionalParams: ['targetDevice', 'syncScope'],
    confidenceThreshold: 0.72,
    riskLevel: 'high',
    fallbackIntent: 'CLARIFY',
  },
  'delivery.skill': {
    id: 'delivery.skill',
    intent: 'SCENE_DELIVERY',
    domainGoal: '总结、归档与交付输出',
    boundedContext: 'Delivery',
    triggerHints: ['总结', '交付', '归档', '复盘'],
    antiPatterns: ['闲聊'],
    requiredParams: [],
    optionalParams: ['summary', 'format'],
    confidenceThreshold: 0.63,
    riskLevel: 'medium',
    fallbackIntent: 'CLARIFY',
  },
  'identity.skill': {
    id: 'identity.skill',
    intent: 'AGENT_IDENTITY',
    domainGoal:
      '回答身份与能力边界问题，明确 Zeno 是“多端协同指挥官”及其全链路自动化职能',
    boundedContext: 'Conversation/Safety',
    triggerHints: ['你是谁', '你的能力', '你能做什么'],
    antiPatterns: ['执行型操作'],
    requiredParams: [],
    optionalParams: [],
    confidenceThreshold: 0.55,
    riskLevel: 'low',
    fallbackIntent: 'CLARIFY',
  },
  'safety.skill': {
    id: 'safety.skill',
    intent: 'SAFE_REFUSAL',
    domainGoal: '识别并拒绝不安全请求',
    boundedContext: 'Conversation/Safety',
    triggerHints: ['违规', '危险', '绕过', '攻击'],
    antiPatterns: ['普通办公请求'],
    requiredParams: [],
    optionalParams: [],
    confidenceThreshold: 0.8,
    riskLevel: 'high',
    fallbackIntent: 'CLARIFY',
  },
  'clarify.skill': {
    id: 'clarify.skill',
    intent: 'CLARIFY',
    domainGoal: '对低置信或缺参请求进行澄清',
    boundedContext: 'Conversation/Safety',
    triggerHints: ['不明确', '不完整', '模糊'],
    antiPatterns: ['明确执行请求'],
    requiredParams: [],
    optionalParams: [],
    confidenceThreshold: 0,
    riskLevel: 'low',
    fallbackIntent: 'CLARIFY',
  },
  'chitchat.skill': {
    id: 'chitchat.skill',
    intent: 'CHITCHAT',
    domainGoal: '处理通用闲聊与问答',
    boundedContext: 'Conversation/Safety',
    triggerHints: ['你好', '谢谢', '聊天', '随便聊聊'],
    antiPatterns: ['明确业务动作'],
    requiredParams: [],
    optionalParams: [],
    confidenceThreshold: 0.5,
    riskLevel: 'low',
    fallbackIntent: 'CLARIFY',
  },
};

export const SKILL_BY_INTENT: Record<IntentType, SkillDefinition> = {
  SCENE_PLAN: SKILL_REGISTRY['planning.skill'],
  SCENE_DOC: SKILL_REGISTRY['documentation.skill'],
  SCENE_PRESENT: SKILL_REGISTRY['presentation.skill'],
  SCENE_SYNC: SKILL_REGISTRY['sync.skill'],
  SCENE_DELIVERY: SKILL_REGISTRY['delivery.skill'],
  AGENT_IDENTITY: SKILL_REGISTRY['identity.skill'],
  SAFE_REFUSAL: SKILL_REGISTRY['safety.skill'],
  CLARIFY: SKILL_REGISTRY['clarify.skill'],
  CHITCHAT: SKILL_REGISTRY['chitchat.skill'],
};

export function getSkillByIntent(intent: IntentType): SkillDefinition {
  return SKILL_BY_INTENT[intent] ?? SKILL_REGISTRY['clarify.skill'];
}

export function toSkillPlan(primarySkill: SkillMatch): SkillExecutionPlan {
  return {
    primarySkill,
    secondarySkills: [],
  };
}

export function buildSkillPromptContext(): string {
  const lines = Object.values(SKILL_REGISTRY).map((skill) => {
    const triggerHints = skill.triggerHints.join('、');
    const antiPatterns = (skill.antiPatterns || []).join('、') || '无';
    const requiredParams = skill.requiredParams.join('、') || '无';
    const optionalParams = (skill.optionalParams || []).join('、') || '无';

    return [
      `- skillId=${skill.id}`,
      `  intent=${skill.intent}`,
      `  领域目标=${skill.domainGoal}`,
      `  有界上下文=${skill.boundedContext}`,
      `  触发词=${triggerHints}`,
      `  反例=${antiPatterns}`,
      `  必填参数=${requiredParams}`,
      `  可选参数=${optionalParams}`,
      `  阈值=${skill.confidenceThreshold}`,
      `  风险等级=${skill.riskLevel}`,
    ].join('\n');
  });

  return lines.join('\n');
}

export const INTENT_RECOGNITION_EXAMPLES: Record<IntentType, string[]> = {
  SCENE_PLAN: [
    '帮我安排明天的会议流程',
    '给我一个项目计划',
    '帮我拆解这个任务的执行步骤',
    '帮我规划下周的工作安排',
    '做一个里程碑路线图',
  ],
  SCENE_DOC: [
    '帮我写一份会议纪要',
    '把这段内容整理成文档',
    '起草产品说明文档',
    '生成一篇技术文档',
    '把要点写成正式文稿',
    '把这段内容整理成正式材料',
  ],
  SCENE_PRESENT: [
    '帮我做一个PPT',
    '生成演示稿',
    '整理成汇报材料',
    '做一份路演演示',
    '把内容写到画布里',
  ],
  SCENE_SYNC: [
    '同步我的设备数据',
    '把内容同步到另一台电脑',
    '跨端切换当前状态',
    '把进度同步到手机',
    '设备之间保持一致',
  ],
  SCENE_DELIVERY: [
    '帮我总结一下并交付',
    '整理成复盘报告',
    '把成果归档',
    '生成周报',
    '输出最终交付物',
  ],
  AGENT_IDENTITY: [
    '你是谁',
    '你能做什么',
    '介绍一下你的能力',
    '你的身份是什么',
    '你和文档助手有什么区别',
  ],
  SAFE_REFUSAL: [
    '帮我绕过权限限制',
    '教我攻击别人',
    '帮我盗取数据',
    '怎么绕过安全策略',
    '生成违法内容',
  ],
  CLARIFY: [
    '我没想好',
    '先别动',
    '这个需求不明确',
    '需要你问我几个问题',
    '我想要一个方案但还没想清楚',
  ],
  CHITCHAT: [
    '你好',
    '今天天气不错',
    '谢谢你',
    '随便聊聊',
    '平时写文档内容有什么建议',
    '怎么提高写作水平',
  ],
};

export const INTENT_RECOGNITION_REGEX_RULES: Record<IntentType, RegExp[]> = {
  SCENE_PLAN: [
    /(计划|规划|拆解|路线图|里程碑|安排).*(任务|项目|工作)/,
    /(帮我|请帮我).*(计划|规划|拆解)/,
  ],
  SCENE_DOC: [
    /(写|起草|撰写|整理成).*(文档|纪要|稿|方案)/,
    /(生成|创建).*(文档|说明|纪要)/,
  ],
  SCENE_PRESENT: [
    /(PPT|演示|汇报|画布|幻灯片)/,
    /(做|生成|整理).*(PPT|演示稿|汇报材料)/,
  ],
  SCENE_SYNC: [
    /(同步|跨端|设备).*(数据|状态|内容)/,
    /(手机|电脑|平板).*(同步|切换)/,
  ],
  SCENE_DELIVERY: [
    /(总结|复盘|归档|交付)/,
    /(输出|生成).*(周报|总结|交付物|报告)/,
  ],
  AGENT_IDENTITY: [
    /(你是谁|你能做什么|你的能力|你的身份)/,
    /(介绍一下|说明一下).*(能力|身份|作用)/,
  ],
  SAFE_REFUSAL: [
    /(攻击|盗取|绕过|破解|违法|木马|钓鱼|入侵)/,
    /(安全策略|权限限制).*(绕过|破解)/,
  ],
  CLARIFY: [/^(先别动|我没想好|需要你问我|再看看|不确定)$/],
  CHITCHAT: [/^(你好|哈喽|谢谢|在吗|随便聊聊)$/],
};
