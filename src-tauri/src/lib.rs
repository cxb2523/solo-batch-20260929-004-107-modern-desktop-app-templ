// this hides the console for Windows release builds
#![cfg_attr(
  all(not(debug_assertions), target_os = "windows"),
  windows_subsystem = "windows"
)]

use serde::Serialize;
use std::sync::Mutex;
use tauri::{
  // state is used in Linux
  self,
  Emitter,
  Manager,
};
use tauri_plugin_store;
use tauri_plugin_window_state;

mod tray_icon;
mod utils;

use tray_icon::{TrayState, create_tray_icon, tray_update_lang};
use utils::long_running_thread;

/// Rust 侧运行时配置快照。
///
/// 决策（与 vite.config.ts / src/config/runtime.ts 对应）：
/// - 前端在构建期静态注入环境变量，换来可摇树、可裁剪、更小的产物体积；
/// - Rust 侧则保留**运行时读取**配置：这份二进制启动时从合并后的 tauri 配置
///   （tauri.conf.<env>.json，由 scripts/tauri-env.mjs 生成）以及可选的
///   `APP_UPDATE_ENDPOINT` 环境变量取值，因此同一份二进制无需重新编译即可热切换
///   更新端点等设置。
/// - 冲突仲裁：前端展示与发起更新检查一律使用构建期注入的值（构建期 wins）；
///   这里读到的运行时值只用于后端日志、预热/覆盖下载地址等宿主侧行为，绝不回灌
///   给前端做环境判断。
#[derive(Clone, Debug)]
struct RuntimeConfig {
    /// 合并配置里的 bundle identifier，仅用于宿主侧日志/目录隔离等。
    identifier: String,
    /// 运行时更新端点：配置基线之上允许用环境变量热切换；缺省回退到 tauri 配置。
    update_endpoint: Option<String>,
}

#[derive(Clone, Serialize)]
struct SingleInstancePayload {
  args: Vec<String>,
  cwd: String,
}

#[derive(Debug, Default, Serialize)]
struct Example<'a> {
  #[serde(rename = "Attribute 1")]
  attribute_1: &'a str,
}

#[cfg(target_os = "linux")]
pub struct DbusState(Mutex<Option<dbus::blocking::SyncConnection>>);

#[tauri::command]
fn process_file(filepath: String) -> String {
  println!("Processing file: {}", filepath);
  "Hello from Rust!".into()
}

#[cfg(target_os = "linux")]
unsafe fn webkit_hidpi_workaround() {
  // See: https://github.com/spacedriveapp/spacedrive/issues/1512#issuecomment-1758550164
  std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

unsafe fn main_prelude() {
  #[cfg(target_os = "linux")]
  webkit_hidpi_workaround();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // SAFETY: running on single thread
	unsafe { main_prelude(); }
  // main window should be invisible to allow either the setup delay or the plugin to show the window
  let mut log_builder = tauri_plugin_log::Builder::new().target(tauri_plugin_log::Target::new(
    tauri_plugin_log::TargetKind::LogDir {
      file_name: Some("logs".to_string()),
    },
  ));
  #[cfg(debug_assertions)]
  {
    log_builder = log_builder.target(tauri_plugin_log::Target::new(
      tauri_plugin_log::TargetKind::Webview,
    ));
  }

  tauri::Builder::default()
    .plugin(log_builder.build())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    // custom commands
    .invoke_handler(tauri::generate_handler![tray_update_lang, process_file,])
    // allow only one instance and propagate args and cwd to existing instance
    .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
      app
        .emit("newInstance", SingleInstancePayload { args, cwd })
        .unwrap();
    }))
    // persistent storage with filesystem
    .plugin(tauri_plugin_store::Builder::default().build())
    // save window position and size between sessions
    // if you remove this, make sure to uncomment the mainWebview?.show line in TauriProvider.tsx
    .plugin(tauri_plugin_window_state::Builder::default().build())
    // custom setup code
    .setup(|app| {
      let _ = create_tray_icon(app.handle());
      app.manage(Mutex::new(TrayState::NotPlaying));

      // 运行时读取配置（热切换入口）。identifier 直接读合并后的 tauri 配置；
      // 更新端点允许被 APP_UPDATE_ENDPOINT 环境变量覆盖，便于同包灰度/回滚。
      // 注意：这些值不传回前端——环境判定与界面展示以构建期静态注入为准。
      let config = app.config();
      let runtime_config = RuntimeConfig {
        identifier: config.identifier.clone(),
        update_endpoint: std::env::var("APP_UPDATE_ENDPOINT").ok().or_else(|| {
          // tauri-utils 里 plugins 是元组结构体
          // `PluginConfig(pub HashMap<String, serde_json::Value>)`（无 Deref），
          // 因此经 .0 取出 HashMap 再按插件名索引其 JSON 值。
          config
            .plugins
            .0
            .get("updater")?
            .get("endpoints")?
            .as_array()?
            .first()?
            .as_str()
            .map(|s| s.to_string())
        }),
      };
      log::info!(
        "runtime config (host-side, build-time wins for frontend): identifier={} update_endpoint={:?}",
        runtime_config.identifier,
        runtime_config.update_endpoint
      );
      app.manage(Mutex::new(runtime_config));

      let app_handle = app.handle().clone();
      tauri::async_runtime::spawn(async move { long_running_thread(&app_handle).await });

      #[cfg(target_os = "linux")]
      app.manage(DbusState(Mutex::new(
        dbus::blocking::SyncConnection::new_session().ok(),
      )));

      // TODO: AUTOSTART
      // FOLLOW: https://v2.tauri.app/plugin/autostart/

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// useful crates
// https://crates.io/crates/directories for getting common directories

// TODO: optimize permissions
// TODO: decorations false and use custom title bar
