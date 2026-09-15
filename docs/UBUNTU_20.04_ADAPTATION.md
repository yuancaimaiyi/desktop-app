# Ubuntu 20.04 适配记录（Tauri v2 → v1 降级）

日期：2026-09-15
背景：原项目基于 Tauri 2 + WebKitGTK 4.1，Ubuntu 20.04 无法满足其系统库版本要求，通过降级到 Tauri 1.6 完成本地打包。

---

## 阻塞根因

| 组件 | 项目要求 | Ubuntu 20.04 提供 | 结论 |
|---|---|---|---|
| `webkit2gtk` | 4.1 | 4.0 (2.38.6) | 缺 pkg-config `webkit2gtk-4.1.pc` |
| `javascriptcoregtk` | 4.1 | 4.0 | 同上 |
| `glib-2.0` | ≥ 2.70（Tauri 2 依赖 `glib-sys 0.18`，链上 `gtk 0.18`） | 2.64.6 | **硬阻塞**，符号级不兼容 |
| `rustc` | ≥ 1.77 | 系统 1.75 | 需 rustup 装 stable |

`webkit2gtk` 4.0→4.1 可以用 pkg-config 软链绕过（API 面基本兼容），但 `glib` 2.64→2.70 是硬 ABI 要求，无法绕过。

**结论：Tauri 2 无法在 Ubuntu 20.04 上原生构建，必须升级发行版，或降级到 Tauri v1（本次选择）。**

---

## 环境准备

### 1. Rust 工具链（用 rustup 覆盖系统 rustc）

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"   # 或 source $HOME/.cargo/env
```

系统若已有旧版 `/usr/bin/rustc`，编译时必须让 rustup 的 shim 优先（`export PATH="$HOME/.cargo/bin:$PATH"`），否则 build script 会挑到 1.75。

### 2. 系统依赖（Tauri v1 用 webkit2gtk 4.0）

```bash
sudo apt update
sudo apt install -y \
    libwebkit2gtk-4.0-dev \
    librsvg2-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    build-essential file wget curl pkg-config
```

（如系统里残留 `hera-desktop` 老 deb 依赖 `libwebkit2gtk-4.1-0`，先 `sudo apt --fix-broken install` 让它把老包卸掉再装 4.0-dev。）

### 3. pkg-config 软链（可选，保留兼容）

保留 4.1 软链，方便本机同时构建其他依赖 4.1 的项目：

```bash
cd /usr/lib/x86_64-linux-gnu/pkgconfig/
sudo cp webkit2gtk-4.0.pc webkit2gtk-4.1.pc
sudo cp javascriptcoregtk-4.0.pc javascriptcoregtk-4.1.pc
sudo cp webkit2gtk-web-extension-4.0.pc webkit2gtk-web-extension-4.1.pc
sudo sed -i 's/webkit2gtk-4\.0/webkit2gtk-4.1/g; s/javascriptcoregtk-4\.0/javascriptcoregtk-4.1/g' \
    webkit2gtk-4.1.pc webkit2gtk-web-extension-4.1.pc javascriptcoregtk-4.1.pc

cd /usr/lib/x86_64-linux-gnu
sudo ln -sf libwebkit2gtk-4.0.so.37 libwebkit2gtk-4.1.so
sudo ln -sf libjavascriptcoregtk-4.0.so.18 libjavascriptcoregtk-4.1.so
```

> 注意：这只解决 pkg-config 发现问题，**不能让 Tauri 2 真正跑起来**，因为 glib 版本仍差。留着无副作用。

---

## 代码改动清单

### Rust 侧（`src-tauri/`）

#### `Cargo.toml`

- `tauri = "2"` → `tauri = { version = "1.6", features = ["dialog-open", "dialog-save", "shell-open"] }`
- 删除 `tauri-plugin-dialog`（v1 内置 dialog）
- `tauri-build = "2"` → `tauri-build = "1.5"`
- 新增 `[features] custom-protocol = ["tauri/custom-protocol"]`（v1 打包要求）

#### `tauri.conf.json`（schema 完全不同，整文件重写）

主要差异：

| Tauri 2 | Tauri 1 |
|---|---|
| 顶层 `productName`、`identifier`、`version` | 移入 `package{}` |
| `build.frontendDist` | `build.distDir` |
| `build.devUrl` | `build.devPath` |
| `app.windows`、`app.security` | `tauri.windows`、`tauri.security` |
| `bundle`（顶层） | `tauri.bundle` |
| `capabilities/*.json`（权限） | `tauri.allowlist{}`（配置内联） |
| 窗口无 `label` | 必须有 `label`（多窗口路由用） |

对应的 v1 `allowlist`：
```json
"allowlist": {
  "all": false,
  "dialog": { "all": false, "open": true, "save": true },
  "shell":  { "open": true }
}
```

#### `src/lib.rs`

- 删除 `.plugin(tauri_plugin_dialog::init())`
- `app.path().app_data_dir().unwrap()` → `app.path_resolver().app_data_dir().unwrap()`
- `app.path().resource_dir().ok()` → `app.path_resolver().resource_dir()`（v1 直接返回 `Option`）

#### `src/commands.rs`

- `use tauri::{AppHandle, Emitter, State};` → `use tauri::{AppHandle, Manager, State};`
  （v1 没有独立 `Emitter` trait，`emit_all` 在 `Manager` 上）
- `app.emit("job-event", payload)` → `app.emit_all("job-event", &payload)`

#### 删除的文件/目录

- `src-tauri/capabilities/` 整个目录（v1 用 allowlist 替代）
- `src-tauri/gen/`（v2 生成物）

#### `src/main.rs` 未改

`unsafe { std::env::set_var(...) }` 在 edition 2021 会产生 "unnecessary unsafe" 警告但可编译，不影响功能。

### 前端（`src/`）

#### `package.json`

- `@tauri-apps/api: ^2` → `^1.6.0`
- `@tauri-apps/cli: ^2.11.4` → `^1.6.3`
- 删除 `@tauri-apps/plugin-dialog`

#### 模块路径映射

| Tauri 2 | Tauri 1 |
|---|---|
| `@tauri-apps/api/core` (`invoke`) | `@tauri-apps/api/tauri` |
| `@tauri-apps/api/event` (`listen`) | 同名 |
| `@tauri-apps/api/window` `getCurrentWindow()` | `@tauri-apps/api/window` `appWindow`（单例，无需调用） |
| `@tauri-apps/plugin-dialog` (`open`) | `@tauri-apps/api/dialog` |

改动文件：`src/App.tsx`、`src/api.ts`、`src/views/OperatorsView.tsx`、`src/views/RunView.tsx`。

---

## 构建流程

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd desktop-app
rm -f Cargo.lock src-tauri/Cargo.lock       # 让新版 tauri 重解依赖
rm -rf node_modules package-lock.json
npm install
npm run tauri -- build
```

首次编译约 2 分钟（Rust 侧），完成后产物：

```
target/release/hera-desktop                                                     # 8.7 MB 可执行
target/release/bundle/deb/hera-desktop_0.1.0_amd64.deb                          # 4.2 MB
target/release/bundle/rpm/hera-desktop-0.1.0-1.x86_64.rpm                       # 4.2 MB
target/release/bundle/appimage/hera-desktop_0.1.0_amd64.AppImage                # 72 MB
```

---

## 已知遗留 / 差异

1. **前端 window 单例**：v1 的 `appWindow` 是模块级单例，v2 的 `getCurrentWindow()` 支持多窗口路由。当前应用只有一个 window，无影响。
2. **权限模型简化**：v1 allowlist 是 build-time 静态白名单，v2 capabilities 支持按窗口/URL 动态授权。当前应用未用到动态授权。
3. **CSP**：两版都设置为 `null`。生产环境建议后续收紧。
4. **未来升级 Ubuntu 22.04+ 后**：可以直接回滚本次改动、恢复 Tauri 2。建议保留本文档并在 git 中打个标签方便对照回退。

---

## 参考

- Tauri v1 → v2 官方迁移指南（反向阅读即可）：https://v2.tauri.app/start/migrate/from-tauri-1/
- glib 版本要求：`gtk-rs` 各版本对应表见 https://gtk-rs.org/gtk-rs-core/stable/latest/docs/glib/
- Ubuntu 20.04 focal 提供的 glib 版本：2.64.6（package `libglib2.0-dev`）

---

# 附录：同一次工作中完成的功能修复（非 20.04 相关）

Ubuntu 20.04 编译打通后，运行时发现两处已存在的 bug，一并修复。

## Bug 1：`.hera` 传入 `.insv` 工作流，UI 报"完成"但没产出

**现象**：数据视图打开 `.hera` session 后，切到"运行" → 选"全景拼接" → 点运行 → 容器只输出 1 行初始化 log 就退出 0 → UI 显示"工作流完成 ✓"，但 `hera-output/<UUID>/step_stitch/` 是空文件夹。

**根因**：
- HeraSession 打开的是 `.hera`，`RunView` 无脑用 `session.path` 预填 `inputPath`
- `panorama_stitch_gpu` workflow 声明 `input.ext = [".insv"]`，但前端预填时**没做匹配检查**
- 把 `.hera` 传给容器里的 `MediaSDKTest`，它识别不了这个格式，**静默 exit 0**
- 后端 `dag.rs` 只看 exit_code，不检查输出文件是否真的产出，误判 success

**修复**：

### 前端 `src/views/RunView.tsx`

- 新增 helper `pickInputFromSession(session, wfInput)`：
  - 若 workflow 的 `input.ext` 包含 session 当前文件的后缀 → 用 `session.path`
  - 若需要 `.insv` 而 session 是 `.hera` → 自动切到 `session.insv_path`
  - 兜底：`session.path`
- `useEffect` 依赖从 `[session.path]` 改为 `[session.path, session.insv_path, selected.input]`，workflow 切换时重新挑输入
- `selectWorkflow` 里预填改用 `pickInputFromSession(currentSession, wf.input)`
- `startRun` 加最后一道校验：若 `inputPath` 后缀不在 `selected.input.ext` 白名单里，弹 toast 拒绝启动（防用户手动输入错路径）

### 后端 `runner/src/dag.rs`

在 exit_code 检查通过后（进入 `StepComplete` 之前）新增**输出文件存在性检查**：

- 遍历算子 `outputs`
- `IoType::File` → 必须存在且 `size > 0`
- `IoType::Dir` → 必须存在且非空
- 任一缺失 → 转 `StepFailed`，错误消息含常见原因提示（错文件类型 / GPU 静默失败 / 磁盘权限）

这样即便未来其他算子容器又出现"exit 0 但没产出"的静默失败，UI 也会明确报错，不会再骗过用户。

## Bug 2：Ubuntu 20.04 `~/hera-output` 磁盘几乎写满

**现象**：跑激光重建报"内存不足"。

**根因**：不是内存不足，是 **磁盘不足**。`/` 只剩 27 GB，Docker 里塞了 126.5 GB 未使用镜像 + 56 GB build cache。GLIM 处理时写大量中间点云到临时目录，磁盘写失败被上层报成 OOM。

**处置**：
- 已建议用户 `docker system prune -a --volumes -f` 回收 ~183 GB
- 未来可考虑在 hera-desktop 启动时检查 `output_dir` 所在分区剩余空间，低于阈值弹警告

---

# 变更文件清单（本次全部改动）

| 文件 | 类型 | 说明 |
|---|---|---|
| `src-tauri/Cargo.toml` | 降级 | tauri v2 → v1.6，加 `custom-protocol` feature |
| `src-tauri/tauri.conf.json` | 重写 | v1 schema，allowlist 替代 capabilities |
| `src-tauri/src/lib.rs` | 修改 | `plugin_dialog` 去除；`app.path()` → `app.path_resolver()` |
| `src-tauri/src/commands.rs` | 修改 | `Emitter` → `Manager`；`emit` → `emit_all` |
| `src-tauri/capabilities/` | 删除 | v1 不需要 |
| `src/App.tsx` | 修改 | `getCurrentWindow()` → `appWindow` |
| `src/api.ts` | 修改 | `api/core` → `api/tauri`；`plugin-dialog` → `api/dialog` |
| `src/views/OperatorsView.tsx` | 修改 | 同上 dialog import |
| `src/views/RunView.tsx` | 修改 | 同上 dialog import；**新增 `pickInputFromSession` + workflow ext 校验** |
| `package.json` | 修改 | tauri npm 包 v2 → v1.6；去掉 `plugin-dialog` |
| `runner/src/dag.rs` | 修改 | **新增 step 输出文件存在性检查** |

