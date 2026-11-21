import type { GeoAgentMessageKey } from './en';

/**
 * Simplified Chinese UI strings for the GeoAgent control. Brand names and
 * technical terms (MapLibre JS, Earth Engine, placeholder key formats) are
 * intentionally identical to English. The `Record<GeoAgentMessageKey, string>`
 * annotation keeps the key set in lockstep with `en.ts` at compile time.
 */

export const zhCN: Record<GeoAgentMessageKey, string> = {
  closeButtonLabel: '关闭',
  resizeHandleLabel: '调整 GeoAgent 面板大小',

  statusReady: '就绪',
  statusSetup: '需要配置',
  statusRunning: '运行中',
  statusCancelling: '正在取消',
  statusCancelled: '已取消',
  statusError: '错误',
  statusCopied: '已复制',

  settingsSummary: '模型与提供商',
  providerLabel: '提供商',
  apiKeyLabelGeneric: 'API 密钥',
  keyLabelAnthropic: 'Anthropic API 密钥',
  keyLabelGeneric: 'API 密钥',
  baseUrlLabel: 'API 基础地址',
  modelLabel: '模型',
  useLatestButton: '使用最新',
  modelNamePlaceholder: '模型名称',

  earthEngineSummary: 'Earth Engine',
  earthEngineProjectLabel: '项目 ID',
  eeStatusNoCredentials:
    '应用尚未配置 OAuth Client ID 或访问令牌。请先设置 VITE_GEE_OAUTH_CLIENT_ID 或提供 earthEngine.accessToken，再运行 Earth Engine 工具。',
  eeStatusNoProject: '运行 Earth Engine 工具前请先填写 Earth Engine 项目 ID。',
  eeStatusInitialized: '初始化状态：{initialized}；图层数量：{count}。',
  eeStatusConfigured: 'Earth Engine 工具已配置。',
  eeYes: '是',
  eeNo: '否',

  permissionRowLabel: '智能体权限',
  permissionCodeLabel: 'MapLibre JS',
  permissionDestructiveLabel: '允许删除图层',

  promptLabel: '提示词',
  promptPlaceholder: '为旧金山添加一个红色标记并缩放到该位置。',
  sendButton: '发送',
  cancelButton: '取消',
  copyMarkdownButton: '复制 Markdown',
  clearButton: '清空',

  roleSystem: '系统',
  roleUser: '用户',
  roleAssistant: '助手',
  roleTool: '工具',
  roleError: '错误',

  logReady: '浏览器端 Strands 智能体已就绪（{engine}）。',
  logLoadedWithMissing:
    '浏览器端 Strands 智能体已加载（{engine}）。请添加 {missing} 以开始。',
  logLoaded: '浏览器端 Strands 智能体已加载（{engine}）。',
  logChatCleared: '对话已清空。',
  logCancelRequested: '已请求取消。',
  logRunningTool: '正在运行 {tool}',
  answerCancelled: '已取消。',
  answerDone: '完成。',

  missingBaseUrl: 'API 基础地址',
  missingModel: '模型',
  hintAddMissingToStart: '请添加 {missing} 以开始。',
  hintConfigureProvider: '请先配置提供商。',
  hintAddMissingToSend: '请添加 {missing} 后再发送提示词。',
  hintConfigRequiredToSend: '发送提示词前需要先完成配置。',

  notePressEnterToSaveKey: '按回车键保存 API 密钥。',
  noteApiKeySaved: 'API 密钥已保存。',
  noteEnterCustomModelId: '请输入该自定义端点的模型 ID。',
  noteUsingLatestModel: '使用最新模型：{model}。',

  errorApiKeyRequired: '必须提供 {keyLabel}。',
  errorModelIdRequired: '必须提供模型 ID。',
  errorBaseUrlRequired: '必须提供有效的 http(s) API 基础地址。',
};
