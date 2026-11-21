/// <reference types="vite/client" />

// The examples import binary assets (e.g. the milky way panorama) through
// Vite's asset pipeline. tsconfig excludes this folder from the build, but
// editors still need the ambient module declarations from vite/client.

// The @arcgis/map-components web components are set through React refs and
// plain JSX tags; React 18's JSX types need the intrinsic element declared.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'arcgis-map': DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
      'arcgis-scene': DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      >;
    }
  }
}
