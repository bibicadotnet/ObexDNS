import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'

/**
 * Resolves the closest git tag for version reporting.
 */
function getGitTag(): string {
  try {
    const exactTag = execSync('git tag --points-at HEAD', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
    if (exactTag) return exactTag.split('\n')[0].trim()
  } catch {}

  try {
    const ancestorTag = execSync('git describe --tags --abbrev=0', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
    if (ancestorTag) return ancestorTag
  } catch {}

  try {
    const latestTag = execSync('git tag --sort=-v:refname', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
    if (latestTag) return latestTag.split('\n')[0].trim()
  } catch {}

  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf-8'))
    return pkg.version ? (pkg.version.startsWith('v') ? pkg.version : `v${pkg.version}`) : 'v0.0.0'
  } catch {
    return 'v0.0.0'
  }
}

/**
 * Resolves the short git commit hash for version reporting.
 */
function getGitCommit(): string {
  try {
    const commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8' }).trim()
    if (commit) return commit
  } catch {}

  return process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) ||
         process.env.GITHUB_SHA?.slice(0, 7) ||
         'dev'
}

const gitTag = process.env.VITE_APP_GIT_TAG || getGitTag()
const gitCommit = process.env.VITE_APP_GIT_COMMIT || getGitCommit()
const appVersion = `${gitTag}-${gitCommit}`

/**
 * Compiles/emits SQLite WASM OPFS async proxy worker directly into the build output
 * without placing any raw .js files into the source tree or public directory.
 */
function sqliteWasmPlugin(): Plugin {
  return {
    name: 'sqlite-wasm-assets',
    generateBundle(this: any) {
      const src = path.resolve(__dirname, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js')
      if (fs.existsSync(src)) {
        const source = fs.readFileSync(src, 'utf-8')
        this.emitFile({
          type: 'asset',
          fileName: 'assets/sqlite3-opfs-async-proxy.js',
          source,
        })
        this.emitFile({
          type: 'asset',
          fileName: 'sqlite3-opfs-async-proxy.js',
          source,
        })
      }
    },
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: any) => {
        if (req.url === '/assets/sqlite3-opfs-async-proxy.js' || req.url === '/sqlite3-opfs-async-proxy.js') {
          const src = path.resolve(__dirname, 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js')
          if (fs.existsSync(src)) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
            res.end(fs.readFileSync(src))
            return
          }
        }
        next()
      })
    }
  }
}

/**
 * Replaces @blueprintjs/icons' `allPaths` module with src/shims/blueprint-allPaths.ts.
 *
 * The real module statically imports the path data of EVERY 16px and 20px icon, which
 * drags both icon chunks (~170 kB transferred) into the first page load. Blueprint imports
 * it with a relative specifier ("./allPaths" from index.js, "../allPaths" from
 * allPathsLoader.js), so a plain `resolve.alias` on the package path never matches; match
 * on the importer instead. Icon data is then loaded on demand by the split-by-size loader.
 */
function blueprintAllPathsShim(): Plugin {
  const shim = path.resolve(__dirname, 'src/shims/blueprint-allPaths.ts')
  return {
    name: 'blueprint-allpaths-shim',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/[\\/]@blueprintjs[\\/]icons[\\/]/.test(importer)) return null
      if (!/^\.{1,2}\/allPaths(\.js)?$/.test(source)) return null
      return shim
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  envPrefix: ['VITE_'],
  define: {
    __APP_GIT_TAG__: JSON.stringify(gitTag),
    __APP_GIT_COMMIT__: JSON.stringify(gitCommit),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    blueprintAllPathsShim(),
    sqliteWasmPlugin(),
    react(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src/worker',
      filename: 'sw.ts',
      injectRegister: 'auto',
      registerType: 'autoUpdate',
      manifest: {
        name: process.env.VITE_APP_NAME || process.env.APP_NAME || 'DNS Shield',
        short_name: process.env.VITE_APP_NAME || process.env.APP_NAME || 'DNS Shield',
        theme_color: '#f8fafc',
        icons: []
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    }),
    visualizer({ open: false, filename: './stats.html' })
  ],
  server: {
    host: '127.0.0.1',
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
      '/world-110m.json': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '^/(?!system(?:[/?#]|$))[a-zA-Z0-9]{6}$': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        bypass(req) {
          // Do not proxy browser navigation requests or known frontend routes
          if (req.headers.accept?.includes('text/html') || req.url === '/system' || req.url?.startsWith('/system/')) {
            return req.url;
          }
        }
      }
    }
  },
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  worker: {
    format: 'es',
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // 分割图标包，并继续分割 20px 和 16px 图标，减少编译后主包体积
            if (/[\\/]node_modules[\\/]@blueprintjs[\\/]icons/.test(id)) {
              // Only the per-icon path data goes into the big lazy chunks. Other files under
              // 16px/ and 20px/ (e.g. the icon-name enums) are needed right away and must not
              // pull those chunks into the first page load.
              if (/[\\/]20px[\\/]paths[\\/]/.test(id)) return 'vendor-icons-20';
              if (/[\\/]16px[\\/]paths[\\/]/.test(id)) return 'vendor-icons-16';
              return 'vendor-icons-other';
            }
            if (id.includes('@blueprintjs/core')) {
              return 'vendor-ui-core';
            }
            if (id.includes('react') || id.includes('scheduler')) {
              return 'vendor-react';
            }
            // Exclude recharts from the catch-all so it follows its lazy
            // dynamic-import chain (TrendChart chunk) and is not preloaded.
            if (id.includes('recharts') || id.includes('victory-vendor')) {
              return undefined;
            }
            if (id.includes('@sqlite.org/sqlite-wasm')) {
              return undefined;
            }
            if (id.includes('i18next')) {
              return 'vendor-i18next';
            }
            return 'vendor-utils';
          }
        },
      },
    },
  },
})
