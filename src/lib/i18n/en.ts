/**
 * GeoAgent 控件的英文 UI 文案包。本文件是消息 key 的唯一事实来源（source of
 * truth）：其他语言包必须定义完全相同的 key 集合（通过
 * `Record<GeoAgentMessageKey, string>` 在编译期强制校验）。
 */

/**
 * 英文语言包：覆盖 GeoAgent 面板的全部 UI 文案（标题、状态徽章、设置表单、
 * Earth Engine 区块、权限开关、提示词表单、对话角色、运行日志、配置提示与
 * 错误信息）。字符串中的 `{name}` 为占位符，运行时由 `t()` 用参数插值替换。
 */
export const en = {
  // 面板外观。
  closeButtonLabel: 'Close',
  resizeHandleLabel: 'Resize GeoAgent panel',

  // 状态徽章。
  statusReady: 'Ready',
  statusSetup: 'Setup required',
  statusRunning: 'Running',
  statusCancelling: 'Cancelling',
  statusCancelled: 'Cancelled',
  statusError: 'Error',
  statusCopied: 'Copied',

  // 设置区块。
  settingsSummary: 'Provider & model',
  providerLabel: 'Provider',
  apiKeyLabelGeneric: 'API Key',
  keyLabelAnthropic: 'Anthropic API Key',
  keyLabelGeneric: 'API Key',
  baseUrlLabel: 'API Base URL',
  modelLabel: 'Model',
  useLatestButton: 'Use latest',
  modelNamePlaceholder: 'Model name',

  // Earth Engine 区块。
  earthEngineSummary: 'Earth Engine',
  earthEngineProjectLabel: 'Project ID',
  eeStatusNoCredentials:
    'OAuth Client ID or access token is not configured by this app. Set VITE_GEE_OAUTH_CLIENT_ID or provide earthEngine.accessToken before running Earth Engine tools.',
  eeStatusNoProject:
    'Enter an Earth Engine project ID before running Earth Engine tools.',
  eeStatusInitialized: 'Initialized: {initialized}; layers: {count}.',
  eeStatusConfigured: 'Earth Engine tools configured.',
  eeYes: 'yes',
  eeNo: 'no',

  // 权限开关。
  permissionRowLabel: 'Agent permissions',
  permissionCodeLabel: 'MapLibre JS',
  permissionDestructiveLabel: 'Layer removal',

  // 提示词表单。
  promptLabel: 'Prompt',
  promptPlaceholder: 'Add a red marker for San Francisco and zoom to it.',
  sendButton: 'Send',
  cancelButton: 'Cancel',
  copyMarkdownButton: 'Copy Markdown',

  // 日志角色（原样展示；en 保留历史上的小写形式）。
  roleSystem: 'system',
  roleUser: 'user',
  roleAssistant: 'assistant',
  roleTool: 'tool',
  roleError: 'error',

  // 运行日志与状态消息。{engine} 是实际使用的地图引擎
  // （MapLibre、Mapbox GL JS、Leaflet、OpenLayers）。
  logReady: 'Browser-only Strands agent ready ({engine}).',
  logLoadedWithMissing:
    'Browser-only Strands agent loaded ({engine}). Add your {missing} to start.',
  logLoaded: 'Browser-only Strands agent loaded ({engine}).',
  logChatCleared: 'Chat cleared.',
  logCancelRequested: 'Cancellation requested.',
  logRunningTool: 'Running {tool}',
  logRunningToolsGroup: 'Running tool {tool} (step {step})',
  logToolsEnded: 'Tool calls: {count}',
  logToolRunning: 'Running',
  logToolSucceeded: 'Succeeded',
  logToolFailed: 'Failed',
  logToolCancelled: 'Cancelled',
  logToolUnknown: 'Outcome unknown',
  logToolsCompleted: 'Completed {count} tool calls:',
  logToolStep: '{step}. {tool}',
  answerCancelled: 'Cancelled.',
  answerDone: 'Done.',

  // 缺失配置的名词与提示。
  missingBaseUrl: 'API base URL',
  missingModel: 'model',
  hintAddMissingToStart: 'Add your {missing} to start.',
  hintConfigureProvider: 'Configure a provider to start.',
  hintAddMissingToSend: 'Add your {missing} to send a prompt.',
  hintConfigRequiredToSend: 'Configuration required to send a prompt.',

  // 配置提示。
  notePressEnterToSaveKey: 'Press Enter to save your API key.',
  noteApiKeySaved: 'API key saved.',
  noteEnterCustomModelId: 'Enter the model ID for this custom endpoint.',
  noteUsingLatestModel: 'Using latest model: {model}.',

  // 智能体创建错误。
  errorApiKeyRequired: '{keyLabel} is required.',
  errorModelIdRequired: 'Model id is required.',
  errorBaseUrlRequired: 'A valid http(s) API base URL is required.',
} as const;

/**
 * 所有消息 key 的联合类型：由 `en` 的 key 集合推导而来，其他语言包用它把
 * key 集合与英文包在编译期锁定一致。
 */
export type GeoAgentMessageKey = keyof typeof en;
