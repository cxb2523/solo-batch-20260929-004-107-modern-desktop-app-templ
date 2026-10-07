//! 运行时读取 Tauri 配置（决策一的 Rust 侧）。
//!
//! 与前端的分工：
//! - 前端只使用构建期由 Vite 静态注入的常量（`src/config/runtime.ts`），
//!   可摇树、零运行时解析；
//! - Rust 侧保留运行时读取 `tauri.conf.json`（构建前由
//!   `scripts/tauri-merge.mjs` 按环境物化）的能力，便于不重新打包就热切换
//!   bundle identifier / 更新端点 / 窗口能力；
//! - 两侧一旦冲突，**以构建期注入为准**：界面展示与更新端点选择只认前端
//!   静态值，这里的运行时值仅用于 Rust 自身的插件装配、日志与核对。

use serde::Serialize;
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// 当前环境名（dev / staging / prod），来自物化配置 plugins.appEnv
    pub app_env: String,
    /// bundle identifier，各环境由 overlay 切换
    pub identifier: String,
    /// 更新端点（取 plugins.updater.endpoints 的第一项）
    pub update_endpoints: Vec<String>,
    /// updater 插件是否激活
    pub updater_active: bool,
    /// 主窗口 devtools 能力（prod 必须为 false）
    pub devtools: bool,
}

fn json_get<'a>(value: &'a serde_json::Value, path: &[&str]) -> Option<&'a serde_json::Value> {
    path.iter().try_fold(value, |current, key| current.get(key))
}

/// 从运行时生效的 Tauri 配置中读取环境相关字段。
pub fn read_runtime_config(app: &AppHandle) -> RuntimeConfig {
    let config = app.config();

    let app_env = json_get(&config.plugins, &["appEnv"])
        .and_then(|value| value.as_str())
        .unwrap_or("prod")
        .to_string();

    let update_endpoints = json_get(&config.plugins, &["updater", "endpoints"])
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let updater_active = json_get(&config.plugins, &["updater", "active"])
        .and_then(|value| value.as_bool())
        .unwrap_or(false);

    let devtools = config
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.devtools)
        .unwrap_or(false);

    RuntimeConfig {
        app_env,
        identifier: config.identifier.clone(),
        update_endpoints,
        updater_active,
        devtools,
    }
}

/// 暴露给前端做只读核对；前端不得据此覆盖构建期静态值（冲突时构建期为准）。
#[tauri::command]
pub fn get_runtime_config(app: AppHandle) -> RuntimeConfig {
    read_runtime_config(&app)
}
