#!/usr/bin/env node
/**
 * verify:env —— dev/staging/prod 三态可复现构建校验。
 *
 * 对每个 mode 执行一次真实的 vite build，并断言：
 *   1. 构建期注入的 VITE_APP_* 变量（环境名、更新端点、应用名）出现在产物里；
 *   2. 不带前缀的哨兵 SECRET_NEVER_LEAK 绝不进入产物（envPrefix 白名单有效）；
 *   3. tauri 合并配置的 bundle identifier / 更新端点 / 窗口 devtools 与预期一致；
 *   4. capabilities 与 scripts/tauri-env.mjs 的白名单逐字节一致：
 *      prod 不含 devtools、不含 fs:default / fs:allow-*-recursive 等通配能力，
 *      dev/staging 必须显式包含 devtools；
 *   5. src 下除 src/config/runtime.ts 外没有任何散读 import.meta.env 的文件。
 *
 * 任一断言失败立即以非零码退出，供 CI 三态矩阵统一调用：pnpm run verify:env
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENVS, ENV_SPEC, generateEnv, TAURI_DIR } from './tauri-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const OUT_BASE = join(ROOT, 'build-verify');

const failures = [];
function check(name, condition, detail = '') {
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
	}
}

/** 递归收集目录下全部文件的相对路径。 */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
}

function readCap(file) {
	return JSON.parse(readFileSync(join(TAURI_DIR, 'capabilities', file), 'utf-8'));
}

/** 权限条目归一化为可比较的字符串（对象形式按 identifier 排序后序列化）。 */
function permKey(perm) {
	return typeof perm === 'string' ? perm : JSON.stringify(perm);
}

const FORBIDDEN_IN_PROD = [
	'core:webview:allow-internal-toggle-devtools',
	'fs:default',
	'fs:allow-download-write-recursive',
];

/**
 * 校验侧独立维护的期望白名单（刻意不复用生成器里的 capabilityPermissions）：
 * 这样生成器脚本自身若误放权，verify 才能以“第二真源”抓出来而非自证清白。
 */
const EXPECTED_FS_SCOPE = { identifier: 'fs:scope', allow: ['$APP/*', '$DOCUMENT/*', '$DOWNLOAD/*'] };
const EXPECTED_MIGRATED = {
	common: [
		'core:default',
		'core:window:allow-maximize',
		'core:window:allow-unmaximize',
		'core:window:allow-minimize',
		'core:window:allow-unminimize',
		'core:window:allow-close',
		'core:window:allow-set-decorations',
		'core:window:allow-set-size',
		'core:window:allow-set-fullscreen',
		'core:window:allow-set-focus',
		'core:window:allow-start-dragging',
		'core:window:allow-toggle-maximize',
		'updater:default',
		'store:default',
		'autostart:default',
		'opener:default',
		'log:default',
		'shell:allow-open',
		'shell:default',
		'dialog:allow-message',
		'dialog:default',
		'notification:default',
		'os:allow-platform',
		'os:allow-version',
		'os:allow-os-type',
		'os:allow-family',
		'os:allow-arch',
		'os:allow-exe-extension',
		'os:allow-locale',
		'os:allow-hostname',
		'os:default',
		'process:allow-restart',
		'process:default',
		'fs:allow-write-file',
		'fs:allow-read-dir',
		'fs:allow-mkdir',
		EXPECTED_FS_SCOPE,
	],
	nonProdOnly: [
		'core:webview:allow-internal-toggle-devtools',
		'fs:default',
		'fs:allow-download-write-recursive',
	],
};
const EXPECTED_DESKTOP = {
	common: ['updater:default', 'store:default', 'autostart:default', 'opener:default', 'log:default',
		'core:window:allow-toggle-maximize'],
	nonProdOnly: ['core:webview:allow-internal-toggle-devtools', 'fs:allow-download-write-recursive'],
};
function expectedPerms(env, spec) {
	return env === 'prod' ? [...spec.common] : [...spec.common, ...spec.nonProdOnly];
}

// 5. 源码层：import.meta.env 只允许出现在唯一出口 src/config/runtime.ts。
function verifyNoScatteredEnvReads() {
	console.log('[source] import.meta.env 散读检查');
	const srcDir = join(ROOT, 'src');
	const offenders = [];
	for (const file of walk(srcDir)) {
		if (!/\.(ts|tsx)$/.test(file)) continue;
		const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
		if (rel === 'src/config/runtime.ts') continue;
		const code = stripComments(readFileSync(file, 'utf-8'));
		if (code.includes('import.meta.env')) offenders.push(rel);
	}
	check('import.meta.env 只在 src/config/runtime.ts 读取', offenders.length === 0, offenders.join(', '));
}

/** 去掉行/块注释及字符串字面量，避免把注释里的说明误判成散读。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
		.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
}

function verifyEnv(env) {
	console.log(`\n=== verifying mode: ${env} ===`);
	const spec = ENV_SPEC[env];
	const outDir = join(OUT_BASE, env);
	rmSync(outDir, { recursive: true, force: true });

	// 真实跑一遍 vite 构建（构建期静态注入就在这里发生）。
	// 直接用当前 node 跑 vite 的 CLI 入口，跨平台且无需 shell（避免 .cmd 的 EINVAL 与转义告警）。
	const viteBin = resolve(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
	execFileSync(
		process.execPath,
		[viteBin, 'build', '--mode', env, '--outDir', join('build-verify', env), '--emptyOutDir'],
		{ cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
	);

	const files = walk(outDir);
	const bundle = files
		.filter(f => /\.(js|html|css)$/.test(f))
		.map(f => readFileSync(f, 'utf-8'))
		.join('\n');

	// 1. 注入变量存在。
	check(`${env}: VITE_APP_ENV 注入为 "${env}"`, bundle.includes(`"${env}"`) || bundle.includes(`'${env}'`));
	check(`${env}: 更新端点已注入`, bundle.includes(spec.endpoint));
	check(`${env}: 应用名已注入`, bundle.includes('Product Name'));

	// 2. 前缀白名单：哨兵与任意 SECRET_/TAURI_ENV_ 原值不得泄露。
	check(`${env}: 非 VITE_APP_ 哨兵未泄露`, !bundle.includes('do-not-inline-this-sentinel'));
	check(`${env}: TAURI_ENV_ 构建侧变量未泄露`, !bundle.includes('TAURI_ENV_'));

	// 3+4. 重新生成并读取 tauri 合并配置（capabilities 同时落盘）。
	const config = generateEnv(env);
	check(`${env}: bundle identifier`, config.identifier === spec.identifier, `got ${config.identifier}`);
	const endpoint = config.plugins?.updater?.endpoints?.[0];
	check(`${env}: tauri 更新端点`, endpoint === spec.endpoint, `got ${endpoint}`);
	check(`${env}: 窗口 devtools`, config.app.windows[0].devtools === spec.devtools,
		`got ${config.app.windows[0].devtools}`);
	check(`${env}: merged 配置已产出`, existsSync(join(TAURI_DIR, `tauri.conf.${env}.json`)));

	// capabilities 集合：与白名单逐字节一致，杜绝任何白名单外命令。
	const migrated = readCap('migrated.json');
	const desktop = readCap('desktop.json');
	const expectedMigrated = new Set(expectedPerms(env, EXPECTED_MIGRATED).map(permKey));
	const actualMigrated = migrated.permissions.map(permKey);
	const extra = actualMigrated.filter(p => !expectedMigrated.has(p));
	const missing = [...expectedMigrated].filter(p => !actualMigrated.includes(p));
	check(`${env}: migrated.json 能力集合 == 白名单`, extra.length === 0 && missing.length === 0,
		[...(extra.length ? [`越权: ${extra.join(',')}`] : []), ...(missing.length ? [`缺失: ${missing.join(',')}`] : [])].join('; '));

	const flatDesktop = desktop.permissions.flatMap(p => (typeof p === 'string' ? [p] : []));
	const expectedDesktop = new Set(expectedPerms(env, EXPECTED_DESKTOP));
	const desktopExtra = flatDesktop.filter(p => !expectedDesktop.has(p));
	const desktopMissing = [...expectedDesktop].filter(p => !flatDesktop.includes(p));
	check(`${env}: desktop.json 能力集合 == 白名单`, desktopExtra.length === 0 && desktopMissing.length === 0,
		[...(desktopExtra.length ? [`越权: ${desktopExtra.join(',')}`] : []), ...(desktopMissing.length ? [`缺失: ${desktopMissing.join(',')}`] : [])].join('; '));
	// prod 不允许对象形式的宽泛 scope 之外的 fs 对象权限；scope 必须精确匹配三个目录。
	const prodScope = migrated.permissions.find(p => typeof p === 'object' && p.identifier === 'fs:scope');
	if (env === 'prod') check('prod: fs:scope 精确限定 $APP/$DOCUMENT/$DOWNLOAD',
		!!prodScope && JSON.stringify(prodScope.allow?.slice().sort()) === JSON.stringify([...EXPECTED_FS_SCOPE.allow].sort()));
	if (env === 'prod') {
		const leaked = FORBIDDEN_IN_PROD.filter(p => actualMigrated.includes(p) || flatDesktop.includes(p));
		// prod 的 fs:scope 只能限定到具体目录，禁止 "*" / "$DOWNLOAD/**" 之类通配。
		const scope = migrated.permissions.find(p => typeof p === 'object' && p.identifier === 'fs:scope');
		const wildcard = scope ? scope.allow.some(p => p.includes('**') || p === '*') : false;
		check('prod: 无 devtools 与 fs 通配能力', leaked.length === 0 && !wildcard, leaked.join(', '));
		check('prod: 窗口关闭 devtools', config.app.windows[0].devtools === false);
	} else {
		check(`${env}: 显式放行 devtools`, actualMigrated.includes('core:webview:allow-internal-toggle-devtools')
			&& flatDesktop.includes('core:webview:allow-internal-toggle-devtools'));
	}
}

try {
	verifyNoScatteredEnvReads();
	for (const env of ENVS) verifyEnv(env);
} catch (error) {
	console.error(`\nverify:env 执行异常: ${error?.stack ?? error}`);
	process.exit(1);
}

rmSync(OUT_BASE, { recursive: true, force: true });
if (failures.length > 0) {
	console.error(`\nverify:env 失败 ${failures.length} 项:\n- ${failures.join('\n- ')}`);
	process.exit(1);
}
console.log('\nverify:env 全部通过：dev / staging / prod 注入变量、identifier、capability 集合均符合预期。');
