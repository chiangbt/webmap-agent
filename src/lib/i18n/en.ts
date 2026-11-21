/**
 * English UI strings for the GeoAgent control. This file is the source of
 * truth for the message keys: every other locale must define the same key set
 * (enforced at compile time via `Record<GeoAgentMessageKey, string>`).
 */

export const en = {
  // Panel chrome.
  closeButtonLabel: 'Close',
  resizeHandleLabel: 'Resize GeoAgent panel',

  // Status badges.
  statusReady: 'Ready',
  statusSetup: 'Setup required',
  statusRunning: 'Running',
  statusCancelling: 'Cancelling',
  statusCancelled: 'Cancelled',
  statusError: 'Error',
  statusCopied: 'Copied',

  // Settings section.
  settingsSummary: 'Provider & model',
  providerLabel: 'Provider',
  apiKeyLabelGeneric: 'API Key',
  keyLabelAnthropic: 'Anthropic API Key',
  keyLabelGeneric: 'API Key',
  baseUrlLabel: 'API Base URL',
  modelLabel: 'Model',
  useLatestButton: 'Use latest',
  modelNamePlaceholder: 'Model name',

  // Earth Engine section.
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

  // Permission toggles.
  permissionRowLabel: 'Agent permissions',
  permissionCodeLabel: 'MapLibre JS',
  permissionDestructiveLabel: 'Layer removal',

  // Prompt form.
  promptLabel: 'Prompt',
  promptPlaceholder: 'Add a red marker for San Francisco and zoom to it.',
  sendButton: 'Send',
  cancelButton: 'Cancel',
  copyMarkdownButton: 'Copy Markdown',

  // Log roles (displayed as-is; en keeps the historical lowercase form).
  roleSystem: 'system',
  roleUser: 'user',
  roleAssistant: 'assistant',
  roleTool: 'tool',
  roleError: 'error',

  // Runtime log and status messages. {engine} is the actual map engine in
  // use (MapLibre, Mapbox GL JS, Leaflet, OpenLayers).
  logReady: 'Browser-only Strands agent ready ({engine}).',
  logLoadedWithMissing:
    'Browser-only Strands agent loaded ({engine}). Add your {missing} to start.',
  logLoaded: 'Browser-only Strands agent loaded ({engine}).',
  logChatCleared: 'Chat cleared.',
  logCancelRequested: 'Cancellation requested.',
  logRunningTool: 'Running {tool}',
  answerCancelled: 'Cancelled.',
  answerDone: 'Done.',

  // Missing-configuration nouns and hints.
  missingBaseUrl: 'API base URL',
  missingModel: 'model',
  hintAddMissingToStart: 'Add your {missing} to start.',
  hintConfigureProvider: 'Configure a provider to start.',
  hintAddMissingToSend: 'Add your {missing} to send a prompt.',
  hintConfigRequiredToSend: 'Configuration required to send a prompt.',

  // Configuration notes.
  notePressEnterToSaveKey: 'Press Enter to save your API key.',
  noteApiKeySaved: 'API key saved.',
  noteEnterCustomModelId: 'Enter the model ID for this custom endpoint.',
  noteUsingLatestModel: 'Using latest model: {model}.',

  // Agent creation errors.
  errorApiKeyRequired: '{keyLabel} is required.',
  errorModelIdRequired: 'Model id is required.',
  errorBaseUrlRequired: 'A valid http(s) API base URL is required.',
} as const;

export type GeoAgentMessageKey = keyof typeof en;
