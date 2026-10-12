# hera-desktop 编译与打包

Tauri (Rust + Vite/React) 项目。目标：产出 Ubuntu `.deb` 安装包。

---

## 一次性准备

### 系统依赖 (Ubuntu 22.04)

```bash
sudo apt install -y \
  libgtk-3-dev libwebkit2gtk-4.0-dev libayatana-appindicator3-dev librsvg2-dev \
  libssl-dev build-essential curl wget pkg-config
```

### Node.js 20+ 与 Rust 1.78+

```bash
# Node (nvm 或 nodesource)
node --version   # ≥ 20

# Rust (必须用 rustup，apt 装的 1.75 不认 Cargo.lock v4)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup update stable         # ≥ 1.78
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version              # 必须是 rustup 装的，不是 /usr/bin/cargo
```

> 坑：Ubuntu 22.04 的 `apt install cargo` 是 1.75，不能解析 Tauri 新 Cargo.lock（v4）。必须用 rustup 装 ≥ 1.78 并确保 `$HOME/.cargo/bin` 在 `$PATH` 前面。

### 项目依赖

```bash
cd /home/yuancaimaiyi/xreal_metaloc/desktop-app
npm install                  # 装前端 + tauri-cli
```

---

## 编译 & 打包

### 开发模式（热重载）

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri dev
```
- 前端 (Vite) 热重载
- Rust 侧改了会自动重编
- `workflows/`、`operators/` 从源码目录直接读，改 json 重启应用生效

### 生产打包 (.deb)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
cd /home/yuancaimaiyi/xreal_metaloc/desktop-app
npm run tauri build
```

**输出位置**（tauri 产 3 种格式）：
```
target/release/bundle/
├── deb/hera-desktop_0.1.0_amd64.deb      ← Ubuntu/Debian
├── rpm/hera-desktop-0.1.0-1.x86_64.rpm   ← Fedora/RedHat
└── appimage/hera-desktop_0.1.0_amd64.AppImage ← 跨发行版 (双击执行)
```

**首次编译**：10-20 分钟（Rust 全量 build）；增量 1-3 分钟。

### 安装到本机

```bash
sudo dpkg -i /home/yuancaimaiyi/xreal_metaloc/desktop-app/target/release/bundle/deb/hera-desktop_0.1.0_amd64.deb
```

安装路径：
- 可执行文件: `/usr/bin/hera-desktop`
- 资源 (workflows + operators): `/usr/lib/hera-desktop/`

### 重启应用

```bash
pkill -f hera-desktop
sleep 2
(setsid /usr/bin/hera-desktop >/tmp/hera-desktop.log 2>&1 &)
```

---

## 后台编译（长流程）

```bash
cd /home/yuancaimaiyi/xreal_metaloc/desktop-app && \
  export PATH="$HOME/.cargo/bin:$PATH" && \
  nohup npm run tauri build > /tmp/hera-build.log 2>&1 &

# 查看进度
tail -f /tmp/hera-build.log
```

---

## 常见问题

### Q: `error: failed to parse lock file at: Cargo.lock`

**原因**：apt 装的 cargo 1.75 太旧。

**修复**：
```bash
rustup update stable
export PATH="$HOME/.cargo/bin:$PATH"
cargo --version   # 确认 ≥ 1.78
```

### Q: `cannot find -lsoup-2.4` 或 webkit2gtk 相关链接错

**原因**：Ubuntu 22.04 要装 webkit2gtk 4.0（不是 4.1）。

```bash
sudo apt install -y libwebkit2gtk-4.0-dev
```

### Q: UI 跑起来缺卡片 / 显示老功能

**原因**：
- Release 装的 .deb 用的是打包时刻的 `operators/` 和 `workflows/`
- 改了源码 json 后 **没重打 .deb** → 旧包里是旧 json

**修复**：重跑 `npm run tauri build` → `sudo dpkg -i ...`

### Q: 加了新 workflow 卡片，UI 还是不显示

**原因**：`src/views/RunView.tsx` 的 `VISIBLE_WORKFLOW_IDS` 白名单没加。

**修复**：在白名单里加 workflow 的 `id`，重新 `npm run tauri build`。

### Q: `operators/<id>/operator.json` 改了但没生效

- Dev 模式 (`npm run tauri dev`)：重启应用生效
- Release 模式：必须重打 .deb；sqlite registry 的 image_ref 还会被 pin，但 schema/bindings 来自磁盘 json

---

## 项目结构

```
desktop-app/
├── src/                      ← React/Vite 前端
│   ├── views/RunView.tsx     ← 运行页 (卡片白名单)
│   └── api.ts                ← tauri invoke 类型声明
├── src-tauri/                ← Tauri 外壳
│   ├── src/lib.rs            ← app 入口
│   ├── src/commands.rs       ← tauri commands
│   └── tauri.conf.json       ← bundle 配置 (resources 挂载 workflows + operators)
├── runner/                   ← 独立 crate: workflow DAG 调度器
│   ├── src/workflow.rs       ← Workflow / WorkflowInputToSpec struct
│   ├── src/dag.rs            ← resolve_inputs / resolve_outputs / docker run
│   └── src/injector.rs       ← params → config patch / cli arg
├── operators/<id>/           ← 每个 operator (Dockerfile + operator.json + ...)
│   └── build.sh              ← docker build 本地镜像
├── workflows/<id>.json       ← workflow 定义 (nodes + edges + workflow_input_to)
└── target/release/bundle/    ← tauri 打包产物
```

---

## 相关文档

- `/home/yuancaimaiyi/qiudao_0512/sync/codeup/helmet/PANORAMA_COLORIZE.md` — 全景上色端到端使用手册
- `docs/UBUNTU_20.04_ADAPTATION.md` — Ubuntu 20.04 适配说明（若有）
- `README.md` — 项目总览
