/**
 * React 包装控件：把命令式 GeoAgentControl 挂到 MapLibre 地图上，卸载时自动
 * 移除。组件本身不渲染任何 DOM（返回 null），面板 UI 完全由命令式控件绘制。
 */
import { useEffect, useRef } from 'react';
import { GeoAgentControl } from './GeoAgentControl';
import type { GeoAgentControlReactProps } from '../types';

/**
 * 在 React 应用中托管 GeoAgentControl。
 *
 * @param map MapLibre 地图实例；为空时什么都不做
 * @param onStateChange 可选的状态变化回调（转发控件 statechange 事件）
 * @param options 其余选项原样传给 GeoAgentControl，仅在挂载时读取一次
 * @returns 恒为 null——控件自行管理面板 DOM
 */
export function GeoAgentControlReact({
  map,
  onStateChange,
  ...options
}: GeoAgentControlReactProps): null {
  // 缓存控件实例，供折叠受控同步与卸载清理使用。
  const controlRef = useRef<GeoAgentControl | null>(null);

  // 挂载/卸载效果：仅依赖 [map]，options 在创建控件时被捕获，
  // 后续 props 变化不会重建控件。
  useEffect(() => {
    if (!map) return;

    const control = new GeoAgentControl(options);
    controlRef.current = control;

    if (onStateChange) {
      // 把控件事件里的状态快照转发给 React 侧回调。
      control.on('statechange', (event) => {
        onStateChange(event.state);
      });
    }

    // 用宿主指定的角停靠控件；未指定时默认 top-right。
    map.addControl(control, options.position || 'top-right');

    return () => {
      // 仅当控件仍在地图上时才移除，避免重复移除抛错。
      if (map.hasControl(control)) {
        map.removeControl(control);
      }
      controlRef.current = null;
    };
  }, [map]);

  // collapsed 受控同步：仅当 props 明确给出 collapsed 且与当前状态不同才切换。
  useEffect(() => {
    if (!controlRef.current) {
      return;
    }
    const currentState = controlRef.current.getState();
    if (options.collapsed !== undefined && options.collapsed !== currentState.collapsed) {
      if (options.collapsed) {
        controlRef.current.collapse();
      } else {
        controlRef.current.expand();
      }
    }
  }, [options.collapsed]);

  return null;
}
