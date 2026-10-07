#!/usr/bin/env node
// 统一入口：先按 mode 物化 Tauri 配置，再把后续参数透传给 tauri CLI。
// 用法：
//   pnpm tauri:dev   dev   -> node scripts/tauri-mode.mjs dev dev
//   pnpm tauri:prod  build -> node scripts/tauri-mode.mjs prod build
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const MODES = ['dev', 'staging', 'prod'];

const mode = process.argv[2];
const tauriArgs = process.argv.slice(3);
if (!MODES.includes(mode)) {
	console.error(`用法: node scripts/tauri-mode.mjs <${MODES.join('|')}> <tauri args...>`);
	process.exit(2);
}

const run = (command, args) => {
	const result = spawnSync(command, args, {
		cwd: repoRoot,
		stdio: 'inherit',
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
};

run(process.execPath, ['scripts/tauri-merge.mjs', mode]);

const generatedConfig = `src-tauri/.tauri-generated/${mode}/tauri.conf.json`;
// 直接用 node 调 tauri CLI 的 JS 入口（Windows 下避免 spawn .cmd 的 EINVAL）
const tauriBinCandidates = [
	'node_modules/@tauri-apps/cli/tauri.js',
	'node_modules/@tauri-apps/cli/run.js',
];
const tauriBin = tauriBinCandidates
	.map(relative => resolve(repoRoot, relative))
	.find(path => existsSync(path));
if (!tauriBin) {
	console.error('找不到 @tauri-apps/cli 入口（先执行 pnpm install）');
	process.exit(1);
}
run(process.execPath, [tauriBin, ...tauriArgs, '--config', generatedConfig]);
