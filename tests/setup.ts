import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => 'blob:maplibre-worker';
}

// jsdom does not implement SVG geometry APIs. Leaflet probes
// `createSVGRect` at module load to decide whether its SVG renderer is
// usable (L.Browser.svg), so the polyfill must exist before `import L`.
if (
  typeof SVGSVGElement !== 'undefined' &&
  !SVGSVGElement.prototype.createSVGRect
) {
  SVGSVGElement.prototype.createSVGRect = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}

// Cleanup after each test (for React component tests)
afterEach(() => {
  cleanup();
});
