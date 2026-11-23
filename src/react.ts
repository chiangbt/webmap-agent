/**
 * React 入口：引入 React 面板样式，导出 React 包装控件、纯 React 面板组件
 * 与状态 hook，以及核心共享类型。
 */
import './lib/styles/geoagent-panel.css';

// React 包装组件：在 React 应用中把命令式 GeoAgentControl 挂到地图上，
// 卸载时自动移除控件；组件自身不渲染任何 DOM。
export { GeoAgentControlReact } from './lib/core/control/GeoAgentControlReact';
// 纯 React 实现的浮动聊天面板：基于 shadcn/ui 组件直接渲染无头 GeoAgentCore，
// 可放在侧栏、portal 等任意宿主位置。
export { GeoAgentPanel, type GeoAgentPanelProps } from './lib/panel/GeoAgentPanel';
export type { GeoAgentMapFor, GeoAgentMapKind, GeoAgentMaps, GeoAgentOptionsFor } from './lib/core/map-binding';
// 本地维护 GeoAgentState 快照的 React hook（与 GeoAgentCore 事件解耦的轻量方案）。
export { useGeoAgentState } from './lib/hooks';

// 核心共享类型：控件选项、状态快照、会话条目、provider 配置与事件签名。
export type {
  GeoAgentControlEvent,
  GeoAgentControlEventHandler,
  GeoAgentControlOptions,
  GeoAgentControlReactProps,
  GeoAgentConversationChange,
  GeoAgentConversationEntry,
  GeoAgentNoteState,
  GeoAgentProviderConfig,
  GeoAgentProviderId,
  GeoAgentState,
  GeoAgentStatusState,
} from './lib/core/types';

export type { GeoJsonLimits } from './lib/utils/geojson';
