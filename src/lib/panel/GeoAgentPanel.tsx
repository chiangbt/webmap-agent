import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { ChevronDownIcon, CopyIcon, SendIcon, SquareIcon, XIcon } from 'lucide-react';
import { GeoAgentCore } from '../core/GeoAgentCore';
import type {
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
   * Bind the panel to an existing core. When omitted the panel creates and
   * disposes its own core from the remaining props (captured at mount, like
   * the imperative control captures its options).
   */
  core?: GeoAgentCore;
  /**
   * Map to attach the core to: a MapLibre/Mapbox map, or a Leaflet/OpenLayers
   * map when `mapEngine` is configured. Attaching happens on mount and
   * whenever the map instance changes.
   */
  map?: unknown;
  onStateChange?: (state: GeoAgentState) => void;
  /** Panel width in pixels. Defaults to the `panelWidth` option (390). */
  width?: number;
  /** Show the header collapse button (default true). */
  showCollapseButton?: boolean;
  className?: string;
}

/** Badge look for each status kind. */
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

function ConversationEntryView({ entry, roleLabel }: { entry: GeoAgentConversationEntry; roleLabel: string }) {
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
        <div
          className="geoagent-md"
          data-testid="geoagent-entry-markdown"
          dangerouslySetInnerHTML={{ __html: renderMarkdownToSafeHtml(entry.content) }}
        />
      ) : (
        <div className="text-[13px] break-words whitespace-pre-wrap">{entry.content}</div>
      )}
    </div>
  );
}

/**
 * React chat panel for the GeoAgent, built entirely from shadcn/ui components
 * on top of the headless {@link GeoAgentCore}. Render it anywhere (a sidebar,
 * a portal, a docked column) — the core handles map tool wiring, provider
 * persistence, and the agent run lifecycle.
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
  // Own the core unless one is handed in; options are captured at mount.
  const [ownedCore] = useState(() => controlledCore ?? new GeoAgentCore(options));
  const core = controlledCore ?? ownedCore;

  const [state, setState] = useState<GeoAgentState>(() => core.getState());
  const [entries, setEntries] = useState(() => core.getConversation());
  const [status, setStatus] = useState<GeoAgentStatusState>(() => core.getStatus());
  const [note, setNote] = useState<GeoAgentNoteState>(() => ({ text: '', kind: null }));
  const [apiKey, setApiKey] = useState(() => core.getCommittedApiKey());
  const [prompt, setPrompt] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(() => !core.isConfigured());
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
  const onStateChangeRef = useRef(onStateChange);
  const wasConfiguredRef = useRef(core.isConfigured());

  onStateChangeRef.current = onStateChange;

  const provider = core.providerConfig(state.providerId);
  const providerConfigs = core.providerConfigs();
  const configured = core.isConfigured();
  const busy = state.busy;
  const earthEngineEnabled = !!core.options.earthEngine && core.options.earthEngine.enabled !== false;

  // Subscribe to the core streams.
  useEffect(() => {
    const onConversation = (_change: unknown, next: ReturnType<GeoAgentCore['getConversation']>) => {
      setEntries(next);
    };
    const onStatus = (next: GeoAgentStatusState) => setStatus(next);
    const onNote = (next: GeoAgentNoteState) => setNote(next);
    const onStateChange = (event: { state: GeoAgentState }) => {
      setState(event.state);
      onStateChangeRef.current?.(event.state);
    };
    core.onConversation(onConversation);
    core.onStatus(onStatus);
    core.onNote(onNote);
    core.on('statechange', onStateChange);
    return () => {
      core.offConversation(onConversation);
      core.offStatus(onStatus);
      core.offNote(onNote);
      core.off('statechange', onStateChange);
    };
  }, [core]);

  // Attach/detach the map binding.
  useEffect(() => {
    if (!map) {
      return;
    }
    core.attach(map as Parameters<GeoAgentCore['attach']>[0]);
    // attach() reloads the committed key (storage, apiKeys, or the
    // deployment default) — sync it into the field so it is visible.
    setApiKey(core.getCommittedApiKey());
    return () => core.detach();
  }, [core, map]);

  // Dispose an owned core when the panel goes away.
  useEffect(
    () => () => {
      if (!controlledCore) {
        core.dispose();
      }
    },
    [core, controlledCore],
  );

  // Follow the conversation to keep the log scrolled to the newest entry.
  useEffect(() => {
    const log = logRef.current;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }, [entries]);

  // Fold the settings away the first time setup completes (same edge rule as
  // the imperative control: never auto-open, respect manual re-opening).
  useEffect(() => {
    if (configured && !wasConfiguredRef.current) {
      setSettingsOpen(false);
    }
    wasConfiguredRef.current = configured;
  }, [state, configured, core]);

  const submitPrompt = (): void => {
    const text = prompt.trim();
    if (!text || busy) {
      return;
    }
    void core.sendPrompt(text);
    setPrompt('');
  };

  const handlePromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    const textarea = promptRef.current;
    if (event.key === 'Enter' && event.ctrlKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (textarea) {
        textarea.setRangeText('\n', textarea.selectionStart, textarea.selectionEnd, 'end');
        setPrompt(textarea.value);
      }
      return;
    }
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
      requestAnimationFrame(() => {
        textarea.setSelectionRange(next.length, next.length);
      });
    }
  };

  // Collapsed panels render nothing — a docked panel simply disappears from
  // its container until the host calls expand()/sets collapsed={false}.
  if (state.collapsed) {
    return null;
  }

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
      {/* Header */}
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

      {/* Provider & model settings */}
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
                  setApiKey(event.target.value);
                  core.setApiKeyEdited(event.target.value);
                }}
                onBlur={() => core.commitApiKey(apiKey)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    core.commitApiKey(apiKey);
                  }
                }}
              />
            </Label>

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

      {/* Earth Engine settings */}
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
                    setEarthEngineProjectId(event.target.value);
                    core.setEarthEngineSettings({ projectId: event.target.value });
                  }}
                />
              </Label>
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

      {/* Permission toggles */}
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

      {/* Conversation log */}
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

      {/* Prompt form */}
      <form
        className="shrink-0 border-t px-3 pt-2 pb-2.5"
        data-testid="geoagent-form"
        onSubmit={(event) => {
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
          <Button
            type="submit"
            data-testid="geoagent-send"
            disabled={busy || !prompt.trim() || !configured}
            title={configured ? undefined : core.sendBlockedHint()}
          >
            <SendIcon />
            {core.translate('sendButton')}
          </Button>
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
