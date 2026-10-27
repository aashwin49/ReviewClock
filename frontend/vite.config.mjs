import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:3000';

  return {
    root: '.',
    server: { proxy: { '/api': apiTarget, '/hooks': apiTarget } },
    build: { outDir: 'dist', emptyOutDir: true }
  };
});
