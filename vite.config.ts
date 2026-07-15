import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Wraps the built content script bundles in IIFEs so that re-injection
// (e.g. after extension reload with the tab still open) doesn't cause
// "Identifier already declared" SyntaxErrors — each injection gets its
// own function scope regardless of how many times the script runs.
const CONTENT_SCRIPTS = new Set(['heartbeat.js', 'sprite.js']);

function wrapContentScriptsInIIFE(): Plugin {
  return {
    name: 'wrap-content-scripts-iife',
    // generateBundle runs after all transforms; Rollup can't unwrap it here.
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (CONTENT_SCRIPTS.has(fileName) && chunk.type === 'chunk') {
          chunk.code = `;(function(){\n${chunk.code}\n})();`;
        }
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      wrapContentScriptsInIIFE(),
      viteStaticCopy({
        targets: [{ src: 'manifest.json', dest: '.' }],
      }),
    ],
    base: './',
    resolve: {
      alias: { '@': path.resolve(__dirname, 'src') },
    },
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: {
          main:       path.resolve(__dirname, 'index.html'),
          background: path.resolve(__dirname, 'src/extension/background.ts'),
          heartbeat:  path.resolve(__dirname, 'src/extension/content/heartbeat.ts'),
          sprite:     path.resolve(__dirname, 'src/extension/content/sprite.ts'),
          popup:      path.resolve(__dirname, 'popup.html'),
        },
        output: {
          entryFileNames: (chunkInfo) => {
            if (['background', 'heartbeat', 'sprite'].includes(chunkInfo.name)) {
              return `[name].js`;
            }
            return `assets/[name]-[hash].js`;
          },
          chunkFileNames:  `assets/[name]-[hash].js`,
          assetFileNames:  `assets/[name]-[hash].[ext]`,
        },
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
