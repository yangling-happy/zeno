/**
 * 代理工具类，提供公共逻辑
 */
export class AgentUtils {
  /**
   * 更新状态并添加轨迹
   * @param state 当前状态
   * @param updates 状态更新
   * @param nodeName 节点名称
   * @returns 更新后的状态
   */
  static updateStateWithTrace(
    state: any,
    updates: Partial<any>,
    nodeName: string,
  ): any {
    return {
      ...state,
      ...updates,
      trace: [...state.trace, nodeName],
    };
  }

  /**
   * 构建默认的 ActionInstruction
   * @returns 默认的 ActionInstruction
   */
  static buildDefaultActionInstruction() {
    return { type: 'NONE' as const };
  }

  /**
   * 构建基础响应
   * @param message 响应消息
   * @param actionInstruction 操作指令
   * @returns 包含响应和操作指令的对象
   */
  static buildResponse(
    message: string,
    actionInstruction?: any
  ) {
    return {
      response: message,
      actionInstruction: actionInstruction || this.buildDefaultActionInstruction(),
    };
  }
}
