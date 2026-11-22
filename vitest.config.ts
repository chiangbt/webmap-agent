import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/',
        'examples/',
        'dist/',
        // 演示站点不是 npm 包代码，不参与覆盖率统计与阈值。
        'src/demo/',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
      // 全局阈值：取当前实测水平（行 69.9 / 分支 68.8 / 函数 76）略低一档，
      // 目标是防覆盖显著回退，而不是精确锁死现状。
      thresholds: {
        lines: 65,
        statements: 65,
        functions: 70,
        branches: 64,
      },
    },
  },
});
