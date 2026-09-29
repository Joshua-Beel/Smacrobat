import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { configDefaults } from 'vitest/config';
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  test: {
    exclude: [...configDefaults.exclude, 'target/**']
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/test-corpus/**'] }
  }
});
