import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/web-geoagent/',
  build: {
    outDir: 'dist-examples',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        basic: resolve(__dirname, 'examples/basic/index.html'),
        earthEngine: resolve(__dirname, 'examples/earth-engine/index.html'),
        react: resolve(__dirname, 'examples/react/index.html'),
        leaflet: resolve(__dirname, 'examples/leaflet/index.html'),
        openlayers: resolve(__dirname, 'examples/openlayers/index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
