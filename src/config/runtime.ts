// ─────────────────────────────────────────────────────────────────────────────
// 前端运行时配置的唯一出口。
//
// 决策一（构建期静态注入 vs 运行时读取）：
//   前端（本文件）只读取 Vite 在构建期静态注入的 import.meta.env['VITE_APP_*']，
//   这些值在产物中是字符串常量，可被摇树 / 内联，没有运行时解析与额外体积。
//   Rust 侧（src-tauri/src/runtime_config.rs）保留运行时读取 tauri.conf.json 的
//   能力，便于不重新打包就热切换。两侧冲突时，以构建期注入为准 —— 界面核对、
//   更新端点选择都只认本模块导出的值，不直接信任 Rust 回传。
//
// 任何组件 / 页面都不得再直接访问 import.meta.env，统一从这里导入；
// scripts/verify-env.mjs 会扫描 src/ 并对违规散读非零退出。
// ─────────────────────────────────────────────────────────────────────────────

export type AppEnv = 'dev' | 'staging' | 'prod';

export interface RuntimeConfig {
	/** 当前构建环境（dev / staging / prod），构建期静态注入 */
	appEnv: AppEnv;
	/** 界面展示用环境名 */
	appEnvLabel: string;
	/** 更新检查端点（与 src-tauri/overlays/tauri.<mode>.conf.json 对齐） */
	updateEndpoint: string;
	/** 供应商标识，所有 mode 共享 */
	vendor: string;
}

function readRequired(key: string): string {
	const value = import.meta.env[key];
	if (typeof value !== 'string' || value.length === 0) {
		// 缺字段必须在构建/启动期立即暴露，而不是静默回退
		throw new Error(`[runtime] 缺少必需的构建期变量 ${key}（检查 .env / .env.<mode>）`);
	}
	return value;
}

function parseAppEnv(raw: string): AppEnv {
	if (raw === 'dev' || raw === 'staging' || raw === 'prod') return raw;
	throw new Error(`[runtime] VITE_APP_ENV 取值非法: "${raw}"`);
}

const appEnv = parseAppEnv(readRequired('VITE_APP_ENV'));

/** 构建期静态注入的运行时配置（常量、可摇树） */
export const runtimeConfig: RuntimeConfig = {
	appEnv,
	appEnvLabel: readRequired('VITE_APP_ENV_LABEL'),
	updateEndpoint: readRequired('VITE_APP_UPDATE_ENDPOINT'),
	vendor: readRequired('VITE_APP_VENDOR'),
};

/** 便于界面区分配色/角标 */
export const isProd = runtimeConfig.appEnv === 'prod';
export const isStaging = runtimeConfig.appEnv === 'staging';
export const isDev = runtimeConfig.appEnv === 'dev';
