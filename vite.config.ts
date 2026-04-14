import process from 'node:process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const appBuildId = process.env.VITE_APP_BUILD_ID?.trim() || new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(appBuildId)
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true
      }
    }
  }
});
