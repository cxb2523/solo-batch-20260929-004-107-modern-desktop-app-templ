import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf-8'));

// https://vitejs.dev/config/
// https://tauri.app/v1/guides/getting-started/setup/vite#create-the-frontend
//
// 环境注入决策（与 src/config/runtime.ts、src-tauri/src/lib.rs 对应）：
//   前端采用“构建期静态注入”——Vite 把命中前缀的变量替换成字面量，环境分支可被
//   摇树、调试代码可从 prod 产物中整体消除，换取更小体积，代价是切环境必须重建。
//   Rust 侧保留运行时读配置（见 lib.rs 注释）以便同一份二进制热切换；两者冲突时
//   一律以构建期注入为准。配置组织采用“单份基线 .env + 每环境薄覆写
//   .env.<mode>”，而不是三份完整文件，避免变量集合在副本之间漂移。
export default defineConfig({
	define: {
		__VERSION__: JSON.stringify(packageJson.version),
	},
  plugins: [
    react(),
    // topLevelAwait({
    //   promiseExportName: '__TLA',
    //   promiseImportName: i => `__TLA_${i}`
    // }),
    visualizer(),
    // removeConsole({includes: ['log', 'assert', 'info', 'error']})
  ],
  // prevent vite from obscuring rust errors
  clearScreen: false,
  // Tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // open in browser if not running with tauri
    open: process.env.TAURI_ENV_ARCH === undefined
  },
  // 唯一放行前缀：src/config/runtime.ts 是这些变量在前端的唯一读取出口。
  // 不能用裸 'VITE_'，否则任何 VITE_* 变量都会被整族泄露进产物。
  // TAURI_ENV_* 只在 Node/构建侧（server.open、minify 等）通过 process.env 读取，
  // 不需要暴露给前端代码。
  envPrefix: ['VITE_APP_'],

  build: {
    // Tauri supports es2021
    target: ['es2021', 'chrome100', 'safari13'],
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG ? 'oxc' : false,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'build',
  }
})
