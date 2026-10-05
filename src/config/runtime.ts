/**
 * 前端运行时配置的唯一出口（single source of truth）。
 *
 * 决策一（构建期静态注入 vs 运行时读取）：
 *   前端这里读取的是 Vite 在构建期静态内联的 `import.meta.env`（仅放行 VITE_APP_
 *   前缀，见 vite.config.ts 的 envPrefix）。静态值在打包时被替换成字面量，未命中
 *   的分支可被打包器摇树（tree-shaking），还能压缩掉调试分支，换来更小的体积；
 *   代价是切换环境必须重新构建。Rust 侧相反：它保留运行时读配置（见
 *   src-tauri/src/lib.rs），以便同一份二进制热切换 endpoint 等设置。两侧若冲突，
 *   一律以构建期注入值为准（构建期 wins），界面展示与检查更新都只信这里的值。
 *
 * 规则：组件/视图/工具函数一律 import { runtimeConfig } from '@/config/runtime'，
 *   禁止在别处直接散读 import.meta.env（verify:env 会扫描并以非零退出拦截）。
 */

/** 受支持的三态环境名，与 .env.<mode>、src-tauri/tauri.<mode>.conf.json 对齐。 */
export type AppEnv = 'dev' | 'staging' | 'prod'

interface ImportMetaAppEnv extends ImportMetaEnv {
	/** 当前环境名；缺失或非法直接判构建失败，杜绝静默落到错误环境。 */
	readonly VITE_APP_ENV?: string
	readonly VITE_APP_NAME?: string
	readonly VITE_APP_UPDATE_ENDPOINT?: string
}

const env = import.meta.env as ImportMetaAppEnv

function required(value: string | undefined, key: string): string {
	if (value === undefined || value === '') {
		// 构建期缺字段应当立刻暴露，而不是把 undefined 带进线上产物。
		throw new Error(`[runtime] required build-time variable ${key} is missing for mode "${import.meta.env.MODE}"`)
	}
	return value
}

function parseEnv(raw: string | undefined): AppEnv {
	if (raw === 'dev' || raw === 'staging' || raw === 'prod') return raw
	throw new Error(`[runtime] VITE_APP_ENV must be one of dev|staging|prod, got ${JSON.stringify(raw)}`)
}

const appEnv = parseEnv(env.VITE_APP_ENV)

/** 构建期冻结的前端配置快照。 */
export interface RuntimeConfig {
	/** dev | staging | prod，用于界面徽标与环境分支。 */
	readonly env: AppEnv
	readonly appName: string
	readonly version: string
	/** tauri-plugin-updater 的更新端点，界面会直接展示便于核对。 */
	readonly updateEndpoint: string
	/** 摇树友好的环境布尔量：prod 产物里 dev 分支整体可被消除。 */
	readonly isDev: boolean
	readonly isStaging: boolean
	readonly isProd: boolean
}

export const runtimeConfig: RuntimeConfig = Object.freeze({
	env: appEnv,
	appName: required(env.VITE_APP_NAME, 'VITE_APP_NAME'),
	version: __VERSION__,
	updateEndpoint: required(env.VITE_APP_UPDATE_ENDPOINT, 'VITE_APP_UPDATE_ENDPOINT'),
	isDev: appEnv === 'dev',
	isStaging: appEnv === 'staging',
	isProd: appEnv === 'prod',
})
