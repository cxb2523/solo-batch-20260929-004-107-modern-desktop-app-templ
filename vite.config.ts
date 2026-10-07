import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf-8'));
const tauriConf = JSON.parse(readFileSync(resolve(import.meta.dirname, 'src-tauri/tauri.conf.json'), 'utf-8'));

// https://vitejs.dev/config/
// https://tauri.app/v1/guides/getting-started/setup/vite#create-the-frontend
// ── 三态（dev/staging/prod）构建链路 ─────────────────────────────────────────
//
// 决策一（前端构建期静态注入 vs Rust 运行时读取）：
//   环境配置在构建期按 mode 从 .env / .env.<mode> 静态注入，产物里只保留
//   字符串常量，可被摇树 / 内联，不做运行时解析，体积更小。
//   对照：Rust 侧保留运行时读 tauri.conf.json（src-tauri/src/runtime_config.rs），
//   用于不重新打包的热切换；两侧冲突时，以构建期注入为准（src/config/runtime.ts）。
//
// 决策二（单份主文件 + 环境覆写，不拆多份完整配置）：
//   .env 为基线，.env.<mode> 只写差异键；Tauri 侧同构：tauri.conf.json 为基线，
//   overlays/tauri.<mode>.conf.json 只写差异，避免窗口/能力定义在多份文件间漂移。
//
// 安全：只放行 VITE_APP_ 前缀。历史上的 VITE_ 会把一切 VITE 开头的变量暴露给
//   前端，这里刻意收窄；TAURI_ENV_* 由 Tauri CLI 在构建期消费，不进入 bundle。
const APP_ENV_PREFIX = 'VITE_APP_';
const APP_MODES = new Set(['dev', 'staging', 'prod']);

export default defineConfig(({ mode }) => {
	// vite 默认 development/production，模板统一到三态名：
	// tauri dev / pnpm start 走 dev，vite build 默认走 prod，也可 --mode staging。
	const appMode = mode === 'development' ? 'dev' : mode === 'production' ? 'prod' : mode;
	if (!APP_MODES.has(appMode)) {
		throw new Error(`[vite] 未知 mode "${mode}"，仅支持 dev / staging / prod`);
	}

	// loadEnv 第三参显式限定前缀：非 VITE_APP_ 的变量永远不会注入前端代码
	const appEnv = loadEnv(appMode, process.cwd(), APP_ENV_PREFIX);
	// 越权防护：即使有人误改了前缀，这里再断言一次注入集合全部带白名单前缀
	for (const key of Object.keys(appEnv)) {
		if (!key.startsWith(APP_ENV_PREFIX)) {
			throw new Error(`[vite] 拒绝注入非白名单变量: ${key}`);
		}
	}

	return {
		define: {
			__VERSION__: JSON.stringify(packageJson.version),
			__APP_NAME__: JSON.stringify(tauriConf.productName),
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
		// 仅放行 VITE_APP_ 前缀的构建期变量；src 侧统一通过 src/config/runtime.ts
		// 读取，组件/页面不得直接访问 import.meta.env（scripts/verify-env.mjs 扫描断言）
		envPrefix: APP_ENV_PREFIX,

		build: {
			// Tauri supports es2021
			target: ['es2021', 'chrome100', 'safari13'],
			// don't minify for debug builds
			minify: !process.env.TAURI_ENV_DEBUG ? 'oxc' : false,
			// produce sourcemaps for debug builds
			sourcemap: !!process.env.TAURI_ENV_DEBUG,
			outDir: 'build',
		}
	}
})