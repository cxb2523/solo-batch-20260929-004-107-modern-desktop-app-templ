declare const __VERSION__: string;
declare const __APP_NAME__: string;

// 构建期静态注入（白名单前缀 VITE_APP_，见 vite.config.ts / src/config/runtime.ts）
interface ImportMetaEnv {
	readonly VITE_APP_ENV: 'dev' | 'staging' | 'prod';
	readonly VITE_APP_ENV_LABEL: string;
	readonly VITE_APP_UPDATE_ENDPOINT: string;
	readonly VITE_APP_VENDOR: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
