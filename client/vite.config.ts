import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

const server = process.env.SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared/src/index.ts') } },
  server: {
    host: true, // 같은 Wi-Fi의 스마트폰에서 접속할 수 있게 한다
    port: 5173,
    proxy: {
      '/socket.io': { target: server, ws: true },
      '/api': { target: server },
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 3000 },
});
