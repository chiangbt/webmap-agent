import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import dts from 'vite-plugin-dts';

export default defineConfig({
  // Expose LLM_* deployment defaults to the demo alongside VITE_* vars.
  envPrefix: ['VITE_', 'LLM_'],
  server: {
    // 监听所有地址（双栈 ::），使 localhost 与 127.0.0.1 都能访问 dev server：
    // 默认 host='localhost' 在本机解析为 IPv6 ::1，只绑 [::1] 会导致 127.0.0.1（IPv4）连不上。
    host: true,
  },
  plugins: [
    react(),
    tailwindcss(),
    dts({
      include: ['src'],
      // The demo site (homepage + examples) is not part of the npm package.
      exclude: ['src/demo'],
      outDir: 'dist/types',
      rollupTypes: false,
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        react: resolve(__dirname, 'src/react.ts'),
      },
      name: 'MapLibreGeoAgent',
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => {
        const ext = format === 'es' ? 'mjs' : 'cjs';
        return `${entryName}.${ext}`;
      },
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'maplibre-gl'],
      output: {
        globals: {
          react: 'React',
          'react-dom': 'ReactDOM',
          'maplibre-gl': 'maplibregl',
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'style.css') return 'web-geoagent.css';
          return assetInfo.name || '';
        },
      },
    },
    cssCodeSplit: false,
    sourcemap: true,
    minify: false,
  },
});
