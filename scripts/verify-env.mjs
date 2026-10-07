#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// pnpm run verify:env
// 对 dev / staging / prod 三种 mode 各构建一次前端，并断言：
//   1. 注入变量：仅 VITE_APP_ 白名单变量进入产物，env / label / endpoint /
//      vendor 四字段齐全且符合该 mode 预期，其它环境端点不得泄漏；
//   2. bundle identifier：物化 Tauri 配置中的 identifier 符合该 mode 预期，
//      更新端点与前端注入值一致，窗口 devtools 能力与基线字段符合预期；
//   3. capability 集合：合并后的白名单命令与 fs:scope 与预期完全相等；
//      prod 不得包含任何 devtools 放开项与 fs 通配（$DOCUMENT/$DOWNLOAD/**、
//      allow-download-write-recursive 等）。
// 任一环境越权或字段缺失 -> 非零退出。
// ─────────────────────────────────────────────────────────────────────────────
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcTauri = resolve(repoRoot, 'src-tauri');
const buildRoot = resolve(repoRoot, 'build-verify');

const MODES = ['dev', 'staging', 'prod'];

const EXPECTED = {
	dev: {
		label: 'Development',
		endpoint: 'https://updates-dev.example.com/{{target}}/{{arch}}/{{current_version}}',
		identifier: 'com.moderndesktop.app.dev',
		devtools: true,
	},
	staging: {
		label: 'Staging',
		endpoint: 'https://updates-staging.example.com/{{target}}/{{arch}}/{{current_version}}',
		identifier: 'com.moderndesktop.app.staging',
		devtools: true,
	},
	prod: {
		label: 'Production',
		endpoint: 'https://updates.example.com/{{target}}/{{arch}}/{{current_version}}',
		identifier: 'com.moderndesktop.app',
		devtools: false,
	},
};

const VENDOR = 'Modern Desktop Template';
const INJECTED_KEYS = [
	'VITE_APP_ENV',
	'VITE_APP_ENV_LABEL',
	'VITE_APP_UPDATE_ENDPOINT',
	'VITE_APP_VENDOR',
];

// ── capability 精确预期（字符串白名单 + fs:scope.allow 集合） ────────────────
const COMMON_PERMISSIONS = [
	'updater:default', 'store:default', 'autostart:default', 'opener:default',
	'log:default', 'core:default', 'core:window:allow-toggle-maximize',
	'core:window:allow-maximize', 'core:window:allow-unmaximize',
	'core:window:allow-minimize', 'core:window:allow-unminimize',
	'core:window:allow-close', 'core:window:allow-set-decorations',
	'core:window:allow-set-size', 'core:window:allow-set-fullscreen',
	'core:window:allow-set-focus', 'core:window:allow-start-dragging',
	'shell:allow-open', 'shell:default', 'dialog:allow-message',
	'dialog:default', 'notification:default', 'os:allow-platform',
	'os:allow-version', 'os:allow-os-type', 'os:allow-family', 'os:allow-arch',
	'os:allow-exe-extension', 'os:allow-locale', 'os:allow-hostname', 'os:default',
	'process:allow-restart', 'process:default',
];

const EXPECTED_PERMISSIONS = {
	dev: {
		strings: [
			...COMMON_PERMISSIONS,
			'core:webview:allow-internal-toggle-devtools',
			'fs:default', 'fs:allow-write-file', 'fs:allow-read-dir',
			'fs:allow-mkdir', 'fs:allow-download-write-recursive',
		].sort(),
		scopeAllow: ['$APP/*', '$DOCUMENT/*', '$DOWNLOAD/*'].sort(),
	},
	staging: {
		strings: [
			...COMMON_PERMISSIONS,
			'core:webview:allow-internal-toggle-devtools',
			'fs:default', 'fs:allow-write-file', 'fs:allow-mkdir',
		].sort(),
		scopeAllow: ['$APP/*', '$DOWNLOAD/*'].sort(),
	},
	prod: {
		strings: [
			...COMMON_PERMISSIONS,
			'core:webview:deny-internal-toggle-devtools',
			'fs:allow-mkdir',
		].sort(),
		scopeAllow: ['$APP/*'].sort(),
	},
};

// prod 红线：字符串权限命中任一子串即越权
const PROD_FORBIDDEN_SUBSTRINGS = [
	'allow-internal-toggle-devtools',
	'allow-download-write-recursive',
	'fs:default',
	'fs:allow-write-file',
	'fs:allow-read-dir',
];
// prod fs:scope 中除 $APP/* 外出现这些即越权（含任何通配路径）
const PROD_FORBIDDEN_SCOPE_HINTS = ['$DOCUMENT', '$DOWNLOAD', '**'];

let failures = 0;

function fail(message) {
	console.error(`  ✗ ${message}`);
	failures += 1;
}

function pass(message) {
	console.log(`  ✓ ${message}`);
}

function assertEqual(actual, expected, message) {
	const actualJson = JSON.stringify(actual);
	const expectedJson = JSON.stringify(expected);
	if (actualJson === expectedJson) pass(message);
	else fail(`${message}\n      expected=${expectedJson}\n      actual=  ${actualJson}`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf-8'));
}

function collectBundleFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = resolve(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectBundleFiles(fullPath));
		else if (/\.(js|mjs|html)$/.test(entry.name)) files.push(fullPath);
	}
	return files;
}

// ── 0. 源码层：src 下除 runtime.ts 外不得散读 import.meta.env ────────────────
function verifyNoScatteredEnvReads() {
	console.log('[source] 扫描 src/ 中散读的 import.meta.env ...');
	const srcDir = resolve(repoRoot, 'src');
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const fullPath = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(fullPath);
			else if (/\.(ts|tsx)$/.test(entry.name)) {
				const relative = fullPath.replaceAll('\\', '/').split('/src/')[1];
				if (relative === 'config/runtime.ts') continue;
				if (readFileSync(fullPath, 'utf-8').includes('import.meta.env')) {
					fail(`src/${relative} 直接读取 import.meta.env，请统一走 src/config/runtime.ts`);
				}
			}
		}
	}
	walk(srcDir);
	if (failures === 0) pass('import.meta.env 仅在 src/config/runtime.ts 中读取');
}

// ── 1. .env 文件层：只允许出现 VITE_APP_ 前缀的键 ───────────────────────────
function verifyEnvFilePrefixes() {
	console.log('[env files] 检查 .env* 变量前缀 ...');
	const before = failures;
	for (const file of ['.env', '.env.dev', '.env.staging', '.env.prod']) {
		for (const line of readFileSync(resolve(repoRoot, file), 'utf-8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const key = trimmed.split('=')[0];
			if (!key.startsWith('VITE_APP_')) {
				fail(`${file} 含非白名单变量 ${key}（仅允许 VITE_APP_ 前缀）`);
			}
		}
	}
	// 每个 mode 需要的字段必须在基线或 mode 文件中提供（字段缺失即失败）
	for (const mode of MODES) {
		const envText =
			readFileSync(resolve(repoRoot, '.env'), 'utf-8') +
			readFileSync(resolve(repoRoot, `.env.${mode}`), 'utf-8');
		for (const key of INJECTED_KEYS) {
			if (!new RegExp(`^${key}=.+`, 'm').test(envText)) {
				fail(`mode ${mode} 缺少字段 ${key}`);
			}
		}
	}
	if (failures === before) pass('.env* 仅定义 VITE_APP_ 前缀变量且三态字段齐全');
}

// ── 2. 逐 mode：物化 Tauri 配置 + 构建前端 + 全量断言 ────────────────────────
function verifyMode(mode) {
	const expected = EXPECTED[mode];
	console.log(`\n[${mode}] 物化 Tauri 配置并构建前端 ...`);
	execFileSync(process.execPath, ['scripts/tauri-merge.mjs', mode], {
		cwd: repoRoot,
		stdio: ['ignore', 'inherit', 'inherit'],
	});

	const outDir = resolve(buildRoot, mode);
	rmSync(outDir, { recursive: true, force: true });
	// 直接用 node 调用 vite 的 bin，避免 Windows 下 spawn .cmd 需要 shell 的 EINVAL
	const viteBin = resolve(
		repoRoot,
		'node_modules/vite/bin/vite.js',
	);
	if (!existsSync(viteBin)) {
		fail(`找不到 vite 可执行文件: ${viteBin}（先执行 pnpm install）`);
		return;
	}
	execFileSync(
		process.execPath,
		[viteBin, 'build', '--mode', mode, '--outDir', outDir],
		{ cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] },
	);

	// 2a. 产物静态注入断言
	const bundle = collectBundleFiles(outDir)
		.map(file => readFileSync(file, 'utf-8'))
		.join('\n');

	if (bundle.includes(expected.endpoint)) pass('更新端点已静态注入产物');
	else fail('产物缺少注入的更新端点字符串');
	if (bundle.includes(expected.label)) pass('环境名已静态注入产物');
	else fail('产物缺少注入的环境名字符串');
	if (bundle.includes(VENDOR)) pass('vendor 已静态注入产物');
	else fail('产物缺少注入的 vendor 字符串');

	// 其它 mode 的端点 / 环境名不得泄漏
	for (const other of MODES) {
		if (other === mode) continue;
		if (bundle.includes(EXPECTED[other].endpoint)) {
			fail(`产物泄漏 ${other} 环境的更新端点`);
		}
		if (bundle.includes(`data-env="${other}"`) || bundle.includes(`"${EXPECTED[other].label}"`)) {
			fail(`产物泄漏 ${other} 环境标识`);
		}
	}

	// 2b. 物化 tauri.conf.json
	const merged = readJson(resolve(srcTauri, `.tauri-generated/${mode}/tauri.conf.json`));
	assertEqual(merged.identifier, expected.identifier, 'bundle identifier 符合预期');

	const endpoints = merged.plugins?.updater?.endpoints ?? [];
	assertEqual(endpoints, [expected.endpoint], 'Tauri 更新端点符合预期');
	assertEqual(merged.plugins?.updater?.active === true, true, 'updater 处于激活状态');
	assertEqual(merged.plugins?.appEnv, mode, 'Rust 运行时 appEnv 与 mode 一致');

	if (endpoints[0] === expected.endpoint && bundle.includes(expected.endpoint)) {
		pass('前端注入端点与 Tauri overlay 端点一致');
	} else fail('前端注入端点与 Tauri overlay 端点不一致');

	const mainWindow = merged.app?.windows?.find(window => window.label === 'main');
	if (!mainWindow) {
		fail('物化配置缺少 label=main 的窗口（窗口定义漂移）');
	} else {
		assertEqual(mainWindow.devtools, expected.devtools, '窗口 devtools 能力符合预期');
		const missingBaselineFields = ['title', 'minWidth', 'minHeight', 'resizable', 'decorations', 'useHttpsScheme']
			.filter(field => !(field in mainWindow));
		if (missingBaselineFields.length === 0) pass('窗口基线字段保留（覆写未造成定义漂移）');
		else fail(`主窗口丢失基线字段: ${missingBaselineFields.join(', ')}`);
	}

	assertEqual(
		merged.app?.security?.capabilities,
		['./desktop.generated.json'],
		'仅加载本环境合并后的单一 capability 文件',
	);

	// 2c. capability 精确集合
	const capability = readJson(
		resolve(srcTauri, `.tauri-generated/${mode}/desktop.generated.json`),
	);
	const strings = capability.permissions
		.filter(permission => typeof permission === 'string')
		.sort();
	const scopePermission = capability.permissions.find(
		permission => typeof permission === 'object' && permission?.identifier === 'fs:scope',
	);
	const scopeAllow = [...(scopePermission?.allow ?? [])].sort();

	assertEqual(strings, EXPECTED_PERMISSIONS[mode].strings, `[${mode}] capability 字符串白名单精确匹配`);
	assertEqual(scopeAllow, EXPECTED_PERMISSIONS[mode].scopeAllow, `[${mode}] fs:scope 集合精确匹配`);

	// 2d. prod 红线（越权即失败）
	if (mode === 'prod') {
		for (const permission of strings) {
			for (const forbidden of PROD_FORBIDDEN_SUBSTRINGS) {
				if (permission.includes(forbidden)) fail(`prod capability 含越权命令: ${permission}`);
			}
		}
		for (const scope of scopeAllow) {
			if (scope !== '$APP/*') {
				fail(`prod fs:scope 含越权路径: ${scope}`);
			}
			for (const hint of PROD_FORBIDDEN_SCOPE_HINTS) {
				if (scope.includes(hint)) fail(`prod fs:scope 含越权路径片段: ${scope}`);
			}
		}
		if (mainWindow?.devtools !== false) fail('prod 窗口 devtools 未关闭');
		pass('prod 红线扫描通过：无 devtools 放开项、无 fs 通配');
	}
}

console.log('═══ verify:env — dev / staging / prod 三态可复现构建校验 ═══');
verifyNoScatteredEnvReads();
verifyEnvFilePrefixes();
for (const mode of MODES) verifyMode(mode);
rmSync(buildRoot, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\nverify:env 失败：${failures} 项断言未通过`);
	process.exit(1);
}
console.log('\nverify:env 全部通过：三态注入变量、bundle identifier 与 capability 集合均符合预期');
