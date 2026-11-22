import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronDownIcon, CopyIcon, SendIcon, SquareIcon, XIcon } from 'lucide-react';
import { GeoAgentCore } from '../core/GeoAgentCore';
import type {
  GeoAgentConversationChange,
  GeoAgentConversationEntry,
  GeoAgentControlOptions,
  GeoAgentNoteState,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from '../core/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../ui/collapsible';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Textarea } from '../ui/textarea';
import { cn } from '../ui/utils';
import { renderMarkdownToSafeHtml } from './markdown';

export interface GeoAgentPanelProps extends GeoAgentControlOptions {
  /**
   * 将面板绑定到一个已有的 core 实例。缺省时面板会用其余 props 创建
   * 并自行释放自己的 core（options 在挂载时捕获一次，与命令式控件
   * 捕获 options 的方式一致）。
   */
  core?: GeoAgentCore;
  /**
   * 要挂载 core 的地图实例：MapLibre/Mapbox 地图，或在配置了 `mapEngine`
   * 时传入 Leaflet/OpenLayers 地图。挂载发生在组件挂载时，并在 map
   * 实例变化时重新挂载。
   */
  map?: unknown;
  onStateChange?: (state: GeoAgentState) => void;
  /** 面板宽度（像素）。缺省取 `panelWidth` 选项（390）。 */
  width?: number;
  /** 是否显示头部折叠按钮（默认 true）。 */
  showCollapseButton?: boolean;
  className?: string;
}

/** 根据状态种类返回对应徽章外观（variant）。 */
function statusVariant(kind: string): ComponentProps<typeof Badge>['variant'] {
  switch (kind) {
    case 'connected':
      return 'success';
    case 'setup':
      return 'warning';
    case 'error':
      return 'destructive';
    default:
      return 'secondary';
  }
}

/**
 * 单条对话条目视图：显示角色标签与内容。内容可按 markdown 渲染
 * （先经 DOMPurify 消毒）或按纯文本换行展示。
 *
 * memo 化是流式渲染性能的关键：core 的 updateEntry 会原地改写条目内容
 * （对象引用不变），增量更新路径对被更新的条目做浅拷贝产生新引用，
 * 其余条目保持引用稳定，因此每个文本增量只重渲染正在输出的那一条，
 * 而不是对整个会话逐条重跑 marked + DOMPurify。
 */
const ConversationEntryView = memo(function ConversationEntryView({
  entry,
  roleLabel,
}: {
  entry: GeoAgentConversationEntry;
  roleLabel: string;
}) {
  return (
    <div
      data-testid="geoagent-entry"
      data-role={entry.role}
      className="border-border/70 border-b py-2 last:border-b-0 last:pb-0"
    >
      <div className="text-muted-foreground mb-0.5 text-[11px] font-extrabold tracking-wide uppercase">
        {roleLabel}
      </div>
      {entry.markdown ? (
        // markdown 模式：先渲染再消毒，结果交给 dangerouslySetInnerHTML 是安全的。
        <div
          className="geoagent-md"
          data-testid="geoagent-entry-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(entry.content) }}
        />
      ) : (
        // 纯文本模式：保留换行并允许断词。
        <div className="text-[13px] break-words whitespace-pre-wrap">{entry.content}</div>
      )}
    </div>
  );
});

/**
 * GeoAgent 的 React 聊天面板：完全基于 shadcn/ui 组件构建，架在无头
 * （headless）的 {@link GeoAgentCore} 之上。可渲染到任意位置（侧栏、
 * portal、停靠列）——地图工具接线、provider 持久化与智能体运行生命周期
 * 都由 core 负责。
 */
export function GeoAgentPanel({
  core: controlledCore,
  map,
  onStateChange,
  width,
  showCollapseButton = true,
  className,
  ...options
}: GeoAgentPanelProps) {
  // 传入 core 就复用，否则自行持有；options 仅在挂载时捕获一次。
  const [ownedCore] = useState(() => controlledCore ?? new GeoAgentCore(options));
  const core = controlledCore ?? ownedCore;

  // 从 core 的当前快照初始化各状态，避免首帧闪烁。
  const [state, setState] = useState<GeoAgentState>(() => core.getState());
  const [entries, setEntries] = useState(() => core.getConversation());
  const [status, setStatus] = useState<GeoAgentStatusState>(() => core.getStatus());
  const [note, setNote] = useState<GeoAgentNoteState>(() => ({ text: '', kind: null }));
  const [apiKey, setApiKey] = useState(() => core.getCommittedApiKey());
  const [prompt, setPrompt] = useState('');
  // 未完成配置时默认展开设置区，方便用户先填 key。
  const [settingsOpen, setSettingsOpen] = useState(() => !core.isConfigured());
  // Earth Engine 区块：缺少凭据（OAuth Client ID / access token 都没有）或
  // 还没有项目 ID 时默认展开，引导用户先完成配置。
  const [earthEngineOpen, setEarthEngineOpen] = useState(() => {
    const ee = core.options.earthEngine;
    const hasCredentials = !!(ee?.oauthClientId?.trim() || ee?.accessToken?.trim());
    return hasCredentials === false || !core.getEarthEngineProjectId();
  });
  const [earthEngineProjectId, setEarthEngineProjectId] = useState(
    () => core.getEarthEngineProjectId(),
  );

  const logRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // 用 ref 持有 onStateChange 回调，使订阅 effect 无需因回调更新而重新绑定。
  const onStateChangeRef = useRef(onStateChange);
  // 记录上一帧的「已配置」状态，用于识别配置完成的边沿。
  const wasConfiguredRef = useRef(core.isConfigured());

  // 每次渲染都同步最新回调到 ref（直接赋值，非 effect）。
  onStateChangeRef.current = onStateChange;

  const provider = core.providerConfig(state.providerId);
  const providerConfigs = core.providerConfigs();
  const configured = core.isConfigured();
  const busy = state.busy;
  // Earth Engine 设置区是否渲染：仅当配置了 earthEngine 且未被显式禁用时显示。
  const earthEngineEnabled = !!core.options.earthEngine && core.options.earthEngine.enabled !== false;

  // 会话增量应用：core 的 updateEntry 是原地改写条目内容（引用不变），
  // 这里对被更新的条目做浅拷贝产生新引用，让 memo 化的条目组件感知变化；
  // 其余条目引用保持稳定，流式期间只有正在输出的那一条重渲染。
  const applyConversation = useCallback(
    (change: GeoAgentConversationChange, next: GeoAgentConversationEntry[]) => {
      if (change.type === 'update' && change.entry) {
        const updatedId = change.entry.id;
        const updated = change.entry;
        setEntries(
          next.map((entry) => (entry.id === updatedId ? { ...updated } : entry)),
        );
        return;
      }
      // append/reset：快照已是新数组，未变更条目的引用保持稳定。
      setEntries(next);
    },
    [],
  );

  // 流式输出期间 core 对每个文本增量都广播一次 update；rAF 合帧把一帧内
  // 的多次更新折叠成一次应用。用最后一次变更类型 + 最后一次全量快照即可
  // 完整表达结果（快照始终是 core 的当前全量状态）。
  const pendingChangeRef = useRef<GeoAgentConversationChange | null>(null);
  const pendingSnapshotRef = useRef<GeoAgentConversationEntry[]>([]);
  const conversationRafRef = useRef<number | null>(null);

  const scheduleConversation = useCallback(
    (change: GeoAgentConversationChange, next: GeoAgentConversationEntry[]) => {
      pendingChangeRef.current = change;
      pendingSnapshotRef.current = next;
      if (conversationRafRef.current !== null) {
        return;
      }
      conversationRafRef.current = requestAnimationFrame(() => {
        conversationRafRef.current = null;
        const pendingChange = pendingChangeRef.current;
        pendingChangeRef.current = null;
        if (pendingChange) {
          applyConversation(pendingChange, pendingSnapshotRef.current);
        }
      });
    },
    [applyConversation],
  );

  // 订阅 core 的各路事件流（对话、状态徽章、配置提示、整体状态）。
  useEffect(() => {
    const onConversation = (change: GeoAgentConversationChange, next: ReturnType<GeoAgentCore['getConversation']>) => {
      scheduleConversation(change, next);
    };
    const onStatus = (next: GeoAgentStatusState) => setStatus(next);
    const onNote = (next: GeoAgentNoteState) => setNote(next);
    const onStateChange = (event: { state: GeoAgentState }) => {
      // 同步 core 状态到 React，同时透传给宿主的 onStateChange 回调。
      setState(event.state);
      onStateChangeRef.current?.(event.state);
    };
    core.onConversation(onConversation);
    core.onStatus(onStatus);
    core.onNote(onNote);
    core.on('statechange', onStateChange);
    // 卸载时解除全部订阅，并取消尚未触发的合帧，避免卸载后 setState。
    return () => {
      core.offConversation(onConversation);
      core.offStatus(onStatus);
      core.offNote(onNote);
      core.off('statechange', onStateChange);
      if (conversationRafRef.current !== null) {
        cancelAnimationFrame(conversationRafRef.current);
        conversationRafRef.current = null;
      }
    };
  }, [core, scheduleConversation]);

  // 挂载/更新时绑定地图，卸载时解绑。
  useEffect(() => {
    if (!map) {
      return;
    }
    core.attach(map as Parameters<GeoAgentCore['attach']>[0]);
    // attach() 会重新加载已提交的 key（来自 storage、apiKeys 或部署默认值）
    // —— 把它同步进输入框以便用户看到当前值。
    setApiKey(core.getCommittedApiKey());
    return () => core.detach();
  }, [core, map]);

  // 面板卸载时释放自建的 core（外部传入的 core 归属宿主，不在此释放）。
  useEffect(
    () => () => {
      if (!controlledCore) {
        core.dispose();
      }
    },
    [core, controlledCore],
  );

  // 跟随对话更新，把日志滚动到最新条目。
  useEffect(() => {
    const log = logRef.current;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }, [entries]);

  // 首次完成配置时自动收起设置区（与命令式控件相同的边沿规则：
  // 绝不自动展开，尊重用户手动重新展开的操作）。
  useEffect(() => {
    if (configured && !wasConfiguredRef.current) {
      setSettingsOpen(false);
    }
    wasConfiguredRef.current = configured;
  }, [state, configured, core]);

  /** 提交提示词：空文本或 agent 忙碌时忽略；发出后清空输入框。 */
  const submitPrompt = (): void => {
    const text = prompt.trim();
    if (!text || busy) {
      return;
    }
    // 发送为异步操作，面板不 await，交给 core 内部管理运行状态。
    void core.sendPrompt(text);
    setPrompt('');
  };

  /**
   * 提示词输入框键盘处理：
   * - Ctrl+Enter 插入换行；裸 Enter 发送；上下方向键在历史记录间回溯。
   * - isComposing 检查避免中文等 IME 组合输入被误当作回车提交。
   */
  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const textarea = promptRef.current;
    // Ctrl+Enter：在光标处插入换行符，并把新文本同步回受控 state。
    if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (textarea) {
        textarea.setRangeText('\n', textarea.selectionStart, textarea.selectionEnd, 'end');
        setPrompt(textarea.value);
      }
      return;
    }
    // 裸 Enter（无修饰键、非 IME 组合中）：直接发送提示词。
    if (
      event.key === 'Enter' &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submitPrompt();
      return;
    }
    // 上/下方向键：回溯输入历史（historyUp/historyDown 返回 null 表示到头了）。
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (!textarea) {
        return;
      }
      const next =
        event.key === 'ArrowUp'
          ? core.historyUp(prompt, textarea.selectionStart, textarea.selectionEnd)
          : core.historyDown(prompt, textarea.selectionStart, textarea.selectionEnd);
      if (next === null) {
        return;
      }
      event.preventDefault();
      setPrompt(next);
      // 等受控值渲染后，把光标移到回填文本的末尾。
      requestAnimationFrame(() => {
        textarea.setSelectionRange(next.length, next.length);
      });
    }
  };

  // 折叠状态的面板不渲染任何内容 —— 停靠面板会从容器中直接消失，
  // 直到宿主调用 expand()/设置 collapsed={false}。
  if (state.collapsed) {
    return null;
  }

  // 面板宽度优先级：width prop > panelWidth 选项 > 默认 390。
  const panelWidth = width ?? options.panelWidth ?? 390;

  return (
    <div
      data-testid="geoagent-panel"
      className={cn(
        'bg-background text-foreground flex h-full min-h-0 w-full flex-col overflow-hidden text-[13px]',
        className,
      )}
      style={{ width: `${panelWidth}px` }}
    >
      {/* 头部 */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="truncate text-sm font-semibold">{options.title ?? 'GeoAgent'}</span>
        <div className="flex items-center gap-1.5">
          <Badge data-testid="geoagent-status" variant={statusVariant(status.kind)}>
            {status.text}
          </Badge>
          {showCollapseButton && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={core.translate('closeButtonLabel')}
              title={core.translate('closeButtonLabel')}
              onClick={() => core.collapse()}
            >
              <XIcon />
            </Button>
          )}
        </div>
      </div>

      {/* 提供商与模型设置 */}
      <Collapsible
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        className="shrink-0 border-b"
      >
        <CollapsibleTrigger
          className="hover:bg-accent/60 flex w-full items-center gap-1 px-3 py-2 text-xs font-semibold"
          data-testid="geoagent-settings-summary"
        >
          <ChevronDownIcon
            className={cn('size-3.5 transition-transform', !settingsOpen && '-rotate-90')}
          />
          {core.translate('settingsSummary')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-2.5 px-3 pt-0.5 pb-3">
            <Label className="flex-col items-start gap-1">
              {core.translate('providerLabel')}
              <Select
                value={state.providerId}
                onValueChange={(value) => {
                  // 切换提供商后重新读取该提供商已提交的 key 回填输入框。
                  core.switchProvider(value as GeoAgentProviderId);
                  setApiKey(core.getCommittedApiKey());
                }}
              >
                <SelectTrigger data-testid="geoagent-provider" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.values(providerConfigs).map((config) => (
                    <SelectItem key={config.id} value={config.id}>
                      {config.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>

            <Label className="flex-col items-start gap-1" htmlFor="geoagent-panel-api-key">
              {core.localizedApiKeyLabel(state.providerId)}
              <Input
                id="geoagent-panel-api-key"
                data-testid="geoagent-api-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={provider.keyPlaceholder}
                onChange={(event) => {
                  // 输入过程先标记为“已编辑”，提交则留到 blur / Enter。
                  setApiKey(event.target.value);
                  core.setApiKeyEdited(event.target.value);
                }}
                onBlur={() => core.commitApiKey(apiKey)}
                onKeyDown={(event) => {
                  // Enter（非 IME 组合中）也可提交 API key。
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    core.commitApiKey(apiKey);
                  }
                }}
              />
            </Label>

            {/* 仅当当前提供商需要自定义 Base URL 时显示该输入项（如 OpenAI 兼容端点）。 */}
            {provider.requiresBaseUrl && (
              <Label className="flex-col items-start gap-1" htmlFor="geoagent-panel-base-url">
                {core.translate('baseUrlLabel')}
                <Input
                  id="geoagent-panel-base-url"
                  data-testid="geoagent-base-url"
                  autoComplete="off"
                  value={state.baseUrl}
                  placeholder={provider.baseUrlPlaceholder || 'https://host/v1'}
                  onChange={(event) => core.setBaseUrl(event.target.value)}
                />
              </Label>
            )}

            <div className="grid gap-1">
              <Label htmlFor="geoagent-panel-model">{core.translate('modelLabel')}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="geoagent-panel-model"
                  data-testid="geoagent-model"
                  autoComplete="off"
                  value={state.modelId}
                  placeholder={provider.defaultModel || core.translate('modelNamePlaceholder')}
                  onChange={(event) => core.setModelId(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="geoagent-load-models"
                  disabled={busy || !provider.defaultModel}
                  title={
                    provider.defaultModel
                      ? undefined
                      : core.translate('noteEnterCustomModelId')
                  }
                  onClick={() => core.applyLatestModel()}
                >
                  {core.translate('useLatestButton')}
                </Button>
              </div>
            </div>

            {/* 配置提示/成功/错误消息（aria-live 保证屏幕阅读器可感知）。 */}
            {note.text && (
              <div
                data-testid="geoagent-config-note"
                className={cn(
                  'rounded-md px-2 py-1 text-xs',
                  note.kind === 'success' && 'bg-primary/10 text-primary',
                  note.kind === 'info' && 'bg-muted text-muted-foreground',
                  note.kind === 'error' && 'bg-destructive/10 text-destructive',
                )}
                aria-live="polite"
              >
                {note.text}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Earth Engine 设置 */}
      {earthEngineEnabled && (
        <Collapsible
          open={earthEngineOpen}
          onOpenChange={setEarthEngineOpen}
          className="shrink-0 border-b"
        >
          <CollapsibleTrigger className="hover:bg-accent/60 flex w-full items-center gap-1 px-3 py-2 text-xs font-semibold">
            <ChevronDownIcon
              className={cn('size-3.5 transition-transform', !earthEngineOpen && '-rotate-90')}
            />
            {core.translate('earthEngineSummary')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="grid gap-2 px-3 pt-0.5 pb-3">
              <Label className="flex-col items-start gap-1" htmlFor="geoagent-panel-ee-project">
                {core.translate('earthEngineProjectLabel')}
                <Input
                  id="geoagent-panel-ee-project"
                  data-testid="geoagent-ee-project-id"
                  autoComplete="off"
                  value={earthEngineProjectId}
                  placeholder="Earth Engine project"
                  onChange={(event) => {
                    // 本地受控值与 core 设置同步更新，保证状态文本即时反映。
                    setEarthEngineProjectId(event.target.value);
                    core.setEarthEngineSettings({ projectId: event.target.value });
                  }}
                />
              </Label>
              {/* Earth Engine 鉴权/初始化状态说明文本。 */}
              <div
                data-testid="geoagent-earth-engine-status"
                className="text-muted-foreground text-xs leading-relaxed"
              >
                {core.getEarthEngineStatusText()}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* 权限开关 */}
      {options.showPermissionToggles && (
        <div
          className="grid shrink-0 gap-1.5 border-b px-3 py-2"
          aria-label={core.translate('permissionRowLabel')}
        >
          <Label className="items-center">
            <Checkbox
              data-testid="geoagent-allow-code"
              checked={state.allowCodeExecution}
              onCheckedChange={(checked) => core.setAllowCodeExecution(checked === true)}
            />
            {core.translate('permissionCodeLabel')}
          </Label>
          <Label className="items-center">
            <Checkbox
              data-testid="geoagent-allow-destructive"
              checked={state.allowDestructiveTools}
              onCheckedChange={(checked) => core.setAllowDestructiveTools(checked === true)}
            />
            {core.translate('permissionDestructiveLabel')}
          </Label>
        </div>
      )}

      {/* 对话日志 */}
      <div
        ref={logRef}
        data-testid="geoagent-log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        {entries.map((entry) => (
          <ConversationEntryView
            key={entry.id}
            entry={entry}
            roleLabel={core.roleLabel(entry.role)}
          />
        ))}
      </div>

      {/* 提示词表单 */}
      <form
        className="shrink-0 border-t px-3 pt-2 pb-2.5"
        data-testid="geoagent-form"
        onSubmit={(event) => {
          // 阻止原生表单提交导致的页面刷新，改走 submitPrompt。
          event.preventDefault();
          submitPrompt();
        }}
      >
        <Label htmlFor="geoagent-panel-prompt">{core.translate('promptLabel')}</Label>
        <Textarea
          id="geoagent-panel-prompt"
          ref={promptRef}
          data-testid="geoagent-prompt"
          className="mt-1 min-h-16"
          value={prompt}
          disabled={busy || !configured}
          placeholder={
            configured
              ? core.translate('promptPlaceholder')
              : core.blockedPromptHint(configured)
          }
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={handlePromptKeyDown}
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* 发送按钮：忙碌、无输入或未配置时禁用；未配置时 title 提示原因。 */}
          <Button
            type="submit"
            data-testid="geoagent-send"
            disabled={busy || !prompt.trim() || !configured}
            title={configured ? undefined : core.sendBlockedHint()}
          >
            <SendIcon />
            {core.translate('sendButton')}
          </Button>
          {/* 取消按钮：仅在运行中且尚未请求过取消时可用。 */}
          <Button
            type="button"
            variant="secondary"
            data-testid="geoagent-cancel"
            disabled={!busy || core.isCancelRequested()}
            onClick={() => core.cancelActiveRun()}
          >
            <SquareIcon />
            {core.translate('cancelButton')}
          </Button>
          {/* 复制按钮：对话为空时禁用；把整段对话复制为 markdown 文本。 */}
          <Button
            type="button"
            variant="secondary"
            data-testid="geoagent-copy"
            disabled={entries.length === 0}
            onClick={() => void core.copyConversationAsMarkdown()}
          >
            <CopyIcon />
            {core.translate('copyMarkdownButton')}
          </Button>
        </div>
      </form>
    </div>
  );
}
