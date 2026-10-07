#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 按环境把 Tauri 配置物化成最终产物：
//   src-tauri/.tauri-generated/<mode>/tauri.conf.json
//   src-tauri/.tauri-generated/<mode>/desktop.generated.json (capability)
//
// 决策二（单份主文件 + 环境覆写，不拆多份完整配置）：
//   tauri.conf.json 永远是唯一完整基线，overlays/tauri.<mode>.conf.json 只写
//   与基线不同的键；capabilities 同理（common.json + profiles/<mode>.json）。
//   Tauri 自带的 --config 合并对数组是“整体替换”，直接用会让窗口定义漂移，
//   所以这里在生成时按 label 深合并 windows，并显式指向单一 capability 文件。
//
// 决策一（构建期 vs 运行时）：Rust 通过 app.config() 仍能在运行时读到这些值
//   （src-tauri/src/runtime_config.rs），前端则只认 Vite 构建期静态注入；
//   冲突时以前者构建期为准。
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const srcTauri = resolve(repoRoot, 'src-tauri');
const MODES = ['dev', 'staging', 'prod'];

const mode = process.argv[2];
if (!MODES.includes(mode)) {
	console.error(`用法: node scripts/tauri-merge.mjs <${MODES.join('|')}>`);
	process.exit(2);
}

const readJson = path => JSON.parse(readFileSync(path, 'utf-8'));
const writeJson = (path, data) =>
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 通用深合并：对象递归；基本类型与数组以 override 替换
function deepMerge(base, override) {
	if (!isPlainObject(base) || !isPlainObject(override)) return override;
	const out = { ...base };
	for (const [key, value] of Object.entries(override)) {
		out[key] = key in out ? deepMerge(base[key], value) : value;
	}
	return out;
}

// app.windows 按 label 合并：保留基线窗口的全部字段，覆写只改同名窗口，
// 杜绝“某环境漏写一个字段导致窗口定义漂移”
function mergeWindows(baseWindows = [], overrideWindows = []) {
	const merged = baseWindows.map(window => ({ ...window }));
	for (const overrideWindow of overrideWindows) {
		const index = merged.findIndex(
			window => window.label === overrideWindow.label,
		);
		if (index === -1) {
			merged.push({ ...overrideWindow });
		} else {
			merged[index] = deepMerge(merged[index], overrideWindow);
		}
	}
	return merged;
}

// capabilities 按 identifier 去重后拼接；fs:scope 对象与同名字符串只保留一份
function mergePermissions(basePermissions = [], overridePermissions = []) {
	const stringSeen = new Set();
	const scopeSeen = new Set();
	const merged = [];
	for (const permission of [...basePermissions, ...overridePermissions]) {
		if (typeof permission === 'string') {
			if (stringSeen.has(permission)) continue;
			stringSeen.add(permission);
			merged.push(permission);
		} else if (isPlainObject(permission) && typeof permission.identifier === 'string') {
			if (scopeSeen.has(permission.identifier)) continue;
			scopeSeen.add(permission.identifier);
			merged.push(permission);
		} else {
			throw new Error(`[tauri-merge] 无法识别的 permission: ${JSON.stringify(permission)}`);
		}
	}
	return merged;
}

const baseConfig = readJson(resolve(srcTauri, 'tauri.conf.json'));
const overlay = readJson(resolve(srcTauri, `overlays/tauri.${mode}.conf.json`));
const commonCapability = readJson(resolve(srcTauri, 'capabilities-src/common.json'));
const profileCapability = readJson(resolve(srcTauri, `capabilities-src/profiles/${mode}.json`));

const windows = mergeWindows(
	baseConfig.app?.windows,
	overlay.app?.windows,
);

// 除 app.windows 外的其余部分走普通深合并
const configWithoutWindows = deepMerge(baseConfig, overlay);
configWithoutWindows.app = { ...configWithoutWindows.app, windows };

// 只加载本环境物化出的单个 capability 文件（相对本配置所在目录）
configWithoutWindows.app = {
	...configWithoutWindows.app,
	security: {
		...configWithoutWindows.app.security,
		capabilities: ['./desktop.generated.json'],
	},
};

const capability = {
	...commonCapability,
	description: `${commonCapability.description} [merged: ${mode}]`,
	permissions: mergePermissions(
		commonCapability.permissions,
		profileCapability.permissions,
	),
};

const outDir = resolve(srcTauri, `.tauri-generated/${mode}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
writeJson(resolve(outDir, 'tauri.conf.json'), configWithoutWindows);
writeJson(resolve(outDir, 'desktop.generated.json'), capability);

console.log(`[tauri-merge] ${mode}: ${outDir}`);
