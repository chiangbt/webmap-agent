/**
 * examples 目录的环境类型声明文件（vite-env.d.ts）。
 *
 * 作用：
 * - 引入 vite/client 的环境模块声明，使编辑器能识别通过 Vite 资源管线
 *   导入的图片等资源模块；
 * - 为 @arcgis/map-components 的 web component 声明 JSX 内置元素类型，
 *   使地图、场景及其控件能在 React 中以普通 JSX 标签使用。
 */
/// <reference types="vite/client" />

// 示例通过 Vite 的资源管线导入二进制资源（例如银河全景图）。
// 资源类型由 vite/client 提供，供示例类型检查使用。

// @arcgis/map-components 的 web component 通过 React ref 与普通 JSX 标签
// 使用；React 18 的 JSX 类型需要显式声明这些内置元素（intrinsic element）。
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      /** ArcGIS 2D 地图视图（MapView）web component。 */
      'arcgis-map': DetailedHTMLProps<HTMLAttributes<HTMLElementTagNameMap['arcgis-map']>, HTMLElementTagNameMap['arcgis-map']> & {
        basemap?: string;
        center?: string;
        zoom?: string;
      };
      /** ArcGIS 3D 场景视图（SceneView）web component。 */
      'arcgis-scene': DetailedHTMLProps<HTMLAttributes<HTMLElementTagNameMap['arcgis-scene']>, HTMLElementTagNameMap['arcgis-scene']> & {
        basemap?: string;
        ground?: string;
        'camera-position'?: string;
        'camera-heading'?: string;
        'camera-tilt'?: string;
      };
      /** 地图 / 场景的缩放按钮 web component。 */
      'arcgis-zoom': DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      'arcgis-home': DetailedHTMLProps<
        HTMLAttributes<HTMLElementTagNameMap['arcgis-home']>,
        HTMLElementTagNameMap['arcgis-home']
      >;
      'arcgis-navigation-toggle': DetailedHTMLProps<
        HTMLAttributes<HTMLElementTagNameMap['arcgis-navigation-toggle']>,
        HTMLElementTagNameMap['arcgis-navigation-toggle']
      >;
      'arcgis-compass': DetailedHTMLProps<
        HTMLAttributes<HTMLElementTagNameMap['arcgis-compass']>,
        HTMLElementTagNameMap['arcgis-compass']
      >;
    }
  }
}
