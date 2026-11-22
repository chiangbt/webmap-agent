import type { GeoAgentMessageKey } from './en';

/**
 * GeoAgent 控件的繁体中文（zh-TW）UI 文案包。全文采用台湾用语习惯
 * （金鑰/位址/專案/提供者/使用者/智慧代理/儲存等），品牌名与技术名词
 * （MapLibre JS、Earth Engine、占位 key 格式等）刻意与英文保持一致。
 * `Record<GeoAgentMessageKey, string>` 类型标注使 key 集合在编译期与
 * `en.ts` 严格对齐。
 */

/**
 * 繁体中文语言包：覆盖 GeoAgent 面板的全部 UI 文案，key 集合与英文包
 * （`en.ts`，key 的事实来源）完全一致。字符串中的 `{name}` 为占位符，
 * 运行时由 `t()` 用参数插值替换。
 */
export const zhTW: Record<GeoAgentMessageKey, string> = {
  closeButtonLabel: '關閉',
  resizeHandleLabel: '調整 GeoAgent 面板大小',

  statusReady: '就緒',
  statusSetup: '需要設定',
  statusRunning: '執行中',
  statusCancelling: '正在取消',
  statusCancelled: '已取消',
  statusError: '錯誤',
  statusCopied: '已複製',

  settingsSummary: '模型與提供者',
  providerLabel: '提供者',
  apiKeyLabelGeneric: 'API 金鑰',
  keyLabelAnthropic: 'Anthropic API 金鑰',
  keyLabelGeneric: 'API 金鑰',
  baseUrlLabel: 'API 基礎位址',
  modelLabel: '模型',
  useLatestButton: '使用最新',
  modelNamePlaceholder: '模型名稱',

  earthEngineSummary: 'Earth Engine',
  earthEngineProjectLabel: '專案 ID',
  eeStatusNoCredentials:
    '應用程式尚未設定 OAuth Client ID 或存取權杖。請先設定 VITE_GEE_OAUTH_CLIENT_ID 或提供 earthEngine.accessToken，再執行 Earth Engine 工具。',
  eeStatusNoProject: '執行 Earth Engine 工具前請先填寫 Earth Engine 專案 ID。',
  eeStatusInitialized: '初始化狀態：{initialized}；圖層數量：{count}。',
  eeStatusConfigured: 'Earth Engine 工具已設定。',
  eeYes: '是',
  eeNo: '否',

  permissionRowLabel: '智慧代理權限',
  permissionCodeLabel: 'MapLibre JS',
  permissionDestructiveLabel: '允許刪除圖層',

  promptLabel: '提示詞',
  promptPlaceholder: '為舊金山新增一個紅色標記並縮放到該位置。',
  sendButton: '傳送',
  cancelButton: '取消',
  copyMarkdownButton: '複製 Markdown',

  roleSystem: '系統',
  roleUser: '使用者',
  roleAssistant: '助手',
  roleTool: '工具',
  roleError: '錯誤',

  logReady: '瀏覽器端 Strands 智慧代理已就緒（{engine}）。',
  logLoadedWithMissing:
    '瀏覽器端 Strands 智慧代理已載入（{engine}）。請新增 {missing} 以開始。',
  logLoaded: '瀏覽器端 Strands 智慧代理已載入（{engine}）。',
  logChatCleared: '對話已清空。',
  logCancelRequested: '已請求取消。',
  logRunningTool: '正在執行 {tool}',
  logRunningToolsGroup: '正在執行工具 {tool}（第 {step} 步）',
  logToolsEnded: '工具呼叫：{count} 次',
  logToolRunning: '執行中',
  logToolSucceeded: '成功',
  logToolFailed: '失敗',
  logToolCancelled: '已取消',
  logToolUnknown: '結果未知',
  logToolsCompleted: '已完成 {count} 次工具呼叫：',
  logToolStep: '{step}. {tool}',
  answerCancelled: '已取消。',
  answerDone: '完成。',

  missingBaseUrl: 'API 基礎位址',
  missingModel: '模型',
  hintAddMissingToStart: '請新增 {missing} 以開始。',
  hintConfigureProvider: '請先設定提供者。',
  hintAddMissingToSend: '請新增 {missing} 後再傳送提示詞。',
  hintConfigRequiredToSend: '傳送提示詞前需要先完成設定。',

  notePressEnterToSaveKey: '按 Enter 鍵儲存 API 金鑰。',
  noteApiKeySaved: 'API 金鑰已儲存。',
  noteEnterCustomModelId: '請輸入該自訂端點的模型 ID。',
  noteUsingLatestModel: '使用最新模型：{model}。',

  errorApiKeyRequired: '必須提供 {keyLabel}。',
  errorModelIdRequired: '必須提供模型 ID。',
  errorBaseUrlRequired: '必須提供有效的 http(s) API 基礎位址。',
};
