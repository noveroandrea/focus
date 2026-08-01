import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig, Plugin } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Content scripts get two post-build fixups (both in generateBundle, after all
// transforms):
//
//  1. INLINE their imports. A content script is injected as a *classic* script —
//     MV3 content_scripts can't be ES modules — so a bare `import ... from` left
//     in the file is a SyntaxError at load and the script silently never runs.
//     Rollup, however, code-splits any module shared with another entry (e.g.
//     src/extension/timings.ts, imported by both background.ts and sprite.ts) into
//     its own chunk. So we pull each imported (dependency-free) chunk's code back
//     inline, wrapped in an arrow-IIFE so its internal names can't clash with the
//     content script's own. The shared chunk still ships for the module entries
//     (background.js) that legitimately import it.
//
//  2. WRAP the result in an IIFE so re-injection (extension reload with the tab
//     still open) doesn't throw "Identifier already declared" — each injection
//     gets its own function scope.
const CONTENT_SCRIPTS = new Set(['heartbeat.js', 'sprite.js']);

function wrapContentScriptsInIIFE(): Plugin {
  const importRe = /import\s*\{([^}]*)\}\s*from\s*"([^"]*)";?/g;
  const exportRe = /export\s*\{([^}]*)\}\s*;?/;

  return {
    name: 'wrap-content-scripts-iife',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!CONTENT_SCRIPTS.has(fileName) || chunk.type !== 'chunk') continue;

        const prefixes: string[] = [];
        const code = chunk.code.replace(importRe, (_m, bindings: string, from: string) => {
          const dep = bundle[from.replace(/^\.\//, '')];
          if (!dep || dep.type !== 'chunk') {
            throw new Error(`Cannot inline "${from}" into ${fileName}: dependency not found in bundle`);
          }
          if (dep.imports.length) {
            throw new Error(`Cannot inline "${from}" into ${fileName}: it has transitive imports`);
          }
          // Parse the dep's export map: exportName -> internal (minified) name.
          const em = dep.code.match(exportRe);
          if (!em) throw new Error(`No export map found in ${from}`);
          const toInternal: Record<string, string> = {};
          for (const part of em[1].split(',')) {
            const [intl, exp] = part.trim().split(/\s+as\s+/);
            toInternal[(exp ?? intl).trim()] = intl.trim();
          }
          // Build "const {exp:local,...} = (()=>{ <body> ; return {exp:internal,...} })()".
          const picks: string[] = [];
          const rets: string[] = [];
          for (const part of bindings.split(',')) {
            const [exp, local] = part.trim().split(/\s+as\s+/);
            const e = exp.trim();
            const intl = toInternal[e];
            if (!intl) throw new Error(`Export "${e}" not found in ${from}`);
            picks.push(`${e}:${(local ?? exp).trim()}`);
            rets.push(`${e}:${intl}`);
          }
          const body = dep.code.replace(exportRe, '').trim();
          prefixes.push(`const {${picks.join(',')}}=(()=>{${body};return{${rets.join(',')}};})();`);
          return ''; // strip the import statement itself
        });

        chunk.code = `;(function(){\n${prefixes.join('\n')}\n${code}\n})();`;
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
          pip:        path.resolve(__dirname, 'pip.html'),
          // The full-tab dashboard. Its own entry so the wide-only charts never
          // ship inside the popup bundle.
          dashboard:  path.resolve(__dirname, 'dashboard.html'),
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
