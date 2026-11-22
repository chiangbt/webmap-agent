import { useCallback, useState } from 'react';
import type { GeoAgentProviderId, GeoAgentState } from '../core/types';

/** 面板状态的默认值：默认收起、宽 390px、空闲、OpenAI 兼容 provider。 */
const DEFAULT_STATE: GeoAgentState = {
  collapsed: true,
  panelWidth: 390,
  busy: false,
  providerId: 'openai-compatible',
  modelId: '',
  baseUrl: '',
  allowCodeExecution: true,
  allowDestructiveTools: true,
  data: {},
};

/**
 * 管理 GeoAgent 面板状态（折叠、宽度、provider、模型、data 附件等）的
 * React hook。基于 `useState` 的函数式更新实现各字段的独立 setter，
 * 所有 setter 均用 `useCallback` 稳定引用，可安全用于 effect 依赖数组。
 *
 * @param initialState - 可选的初始状态覆盖项，与默认值合并作为初始 state
 * @returns 包含 `state`、原始 `setState` 及各字段 setter、`reset`、`toggle` 的集合
 */
export function useGeoAgentState(initialState?: Partial<GeoAgentState>) {
  // 初始 state = 默认值 + 调用方覆盖项（后者优先）。
  const [state, setState] = useState<GeoAgentState>({
    ...DEFAULT_STATE,
    ...initialState,
  });

  // 设置面板是否折叠（收起/展开）。
  const setCollapsed = useCallback((collapsed: boolean) => {
    setState((previous) => ({ ...previous, collapsed }));
  }, []);

  // 设置面板宽度（像素）。
  const setPanelWidth = useCallback((panelWidth: number) => {
    setState((previous) => ({ ...previous, panelWidth }));
  }, []);

  // 切换模型提供商（如 'openai-compatible' / 'anthropic'）。
  const setProviderId = useCallback((providerId: GeoAgentProviderId) => {
    setState((previous) => ({ ...previous, providerId }));
  }, []);

  // 设置模型 ID。
  const setModelId = useCallback((modelId: string) => {
    setState((previous) => ({ ...previous, modelId }));
  }, []);

  // 增量合并 data 附件对象，不覆盖未提及的既有键。
  const setData = useCallback((data: Record<string, unknown>) => {
    setState((previous) => ({ ...previous, data: { ...previous.data, ...data } }));
  }, []);

  // 重置回「默认值 + 初始覆盖项」；initialState 变化时回调引用随之更新。
  const reset = useCallback(() => {
    setState({ ...DEFAULT_STATE, ...initialState });
  }, [initialState]);

  // 在折叠与展开之间切换。
  const toggle = useCallback(() => {
    setState((previous) => ({ ...previous, collapsed: !previous.collapsed }));
  }, []);

  return {
    state,
    setState,
    setCollapsed,
    setPanelWidth,
    setProviderId,
    setModelId,
    setData,
    reset,
    toggle,
  };
}
