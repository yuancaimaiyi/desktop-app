import React, { useState, useEffect, useRef } from "react";
import { App as AntApp, ConfigProvider } from "antd";
import { appWindow } from "@tauri-apps/api/window";
import { _msgRef, _notifRef, toast } from "./components/toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { heraTheme } from "./theme";
import { api, AppConfig, JobEvent, HeraSession } from "./api";
import { DataView } from "./views/DataView";
import { RunView } from "./views/RunView";
import { TaskView } from "./views/TaskView";
import { SettingsView } from "./views/SettingsView";
import { OperatorsView } from "./views/OperatorsView";
import { MemoryView } from "./views/MemoryView";
import { CalibrationView } from "./views/CalibrationView";

type ViewId = "data" | "run" | "tasks" | "memory" | "operators" | "calibration" | "settings";
type LogLine = { text: string; cls: string };

// Captures antd message API into module-level ref for use anywhere via toast.*
function ToastProvider() {
  const { message, notification } = AntApp.useApp();
  _msgRef.current = message;
  _notifRef.current = notification;
  return null;
}

/**
 * F11 切换沉浸式全屏（去标题栏 + 任务栏）。UI 用 flex 布局自适应，不需要手动缩放。
 * 再按 F11 或 Esc 退出。
 */
function useFullscreenToggle() {
  React.useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        const cur = await appWindow.isFullscreen();
        await appWindow.setFullscreen(!cur);
      } else if (e.key === "Escape") {
        // Esc 仅在全屏时退出，不打扰其他 Esc 用途
        const cur = await appWindow.isFullscreen();
        if (cur) {
          e.preventDefault();
          await appWindow.setFullscreen(false);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Ubuntu 20.04 (Tauri v1 + WebKitGTK) 下浏览器的 Ctrl+= / Ctrl+- / Ctrl+0 / Ctrl+滚轮 缩放
 * 快捷键不会被 WebKit 自动响应。这里手动接管，用 CSS `zoom` 作用于 document.body。
 * zoom 属性在 WebKit / Chromium 都支持，且不会影响布局逻辑（不像 transform: scale）。
 */
function useUiZoom() {
  React.useEffect(() => {
    const STORAGE_KEY = "hera-ui-zoom";
    const MIN = 0.6, MAX = 2.0, STEP = 0.1;
    const load = () => {
      const v = parseFloat(localStorage.getItem(STORAGE_KEY) || "1");
      return Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : 1;
    };
    const apply = (v: number) => {
      (document.body.style as unknown as { zoom: string }).zoom = String(v);
      localStorage.setItem(STORAGE_KEY, String(v));
    };
    apply(load());

    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      let cur = load();
      if (e.key === "=" || e.key === "+") {
        cur = Math.min(MAX, cur + STEP);
      } else if (e.key === "-" || e.key === "_") {
        cur = Math.max(MIN, cur - STEP);
      } else if (e.key === "0") {
        cur = 1;
      } else {
        return;
      }
      e.preventDefault();
      apply(cur);
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      let cur = load();
      cur = e.deltaY < 0 ? Math.min(MAX, cur + STEP) : Math.max(MIN, cur - STEP);
      apply(cur);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);
}

const CRUMB_LABELS: Record<ViewId, string> = {
  data:      "会话浏览器",
  run:       "配置与执行",
  tasks:     "任务历史",
  memory:    "空间记忆库",
  operators: "算子仓库",
  calibration: "激光-全景相机标定",
  settings:  "首选项",
};

const VIEW_LABELS: Record<ViewId, string> = {
  data:      "数据",
  run:       "运行",
  tasks:     "任务",
  memory:    "记忆",
  operators: "算子",
  calibration: "标定",
  settings:  "设置",
};

export function App() {
  useUiZoom();
  useFullscreenToggle();
  const [view, setView]               = useState<ViewId>("data");
  const [config, setConfig]           = useState<AppConfig | null>(null);
  const [currentSession, setCurrentSession] = useState<HeraSession | null>(null);
  const [logs, setLogs]           = useState<LogLine[]>([]);
  const [outOpen, setOutOpen]     = useState(true);
  const [running, setRunning]     = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [stepLabel, setStepLabel] = useState("");
  const [elapsed, setElapsed]     = useState<string | null>(null);
  const [locator, setLocator]     = useState("");
  const [subCrumb, setSubCrumb]   = useState<string>("");
  const t0 = useRef<number>(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  // Global job-event subscription for output pane + status bar
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    api.onJobEvent(handleGlobalEvent).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [logs]);

  function handleGlobalEvent(ev: JobEvent) {
    switch (ev.type) {
      case "step_start":
        if (!running) {
          t0.current = Date.now();
          setElapsed(null);
          setProgressPct(0);
        }
        setRunning(true);
        setStepLabel(ev.step ?? "");
        appendLog(`[${ev.step}] 启动  image=${ev.image}`, "meta");
        break;
      case "log":
        appendLog(`[${ev.step}] ${ev.text}`, ev.is_stderr ? "stderr" : "");
        break;
      case "step_failed":
        appendLog(`[${ev.step}] FAILED exit=${ev.exit_code}${ev.reason ? `\n${ev.reason}` : ""}`, "stderr");
        break;
      case "job_complete":
        setRunning(false);
        setProgressPct(100);
        setStepLabel("");
        setElapsed(((Date.now() - t0.current) / 1000).toFixed(1));
        appendLog("工作流完成 ✓", "ok");
        break;
      case "job_failed":
        setRunning(false);
        setStepLabel("");
        appendLog(`工作流失败: ${ev.reason}`, "stderr");
        toast.dockerError(ev.reason ?? "未知错误", "工作流执行失败");
        break;
    }
  }

  function appendLog(text: string, cls: string) {
    setLogs((prev) => [...prev, { text, cls }]);
    if (!outOpen) setOutOpen(true);
  }

  const runtime = config?.runtime?.container ?? "docker";
  const gpuOff  = !(config?.runtime?.gpu_enabled);

  const crumb = CRUMB_LABELS[view];
  const crumbLeaf = subCrumb || crumb;

  return (
    <ConfigProvider theme={heraTheme}>
    <AntApp>
      <ToastProvider />
      <div className="hs-root">

        {/* ── Title bar ── */}
        <div className="hs-titlebar">
          <div className="hs-titlebar-logo">H</div>
          <div className="hs-titlebar-menus">
            {["文件","编辑","构建","调试","分析","工具","窗口","帮助"].map((m) => (
              <span key={m}>{m}</span>
            ))}
          </div>
          <div className="hs-titlebar-title">
            Hera Studio — {VIEW_LABELS[view]}
            {currentSession && (
              <span style={{ marginLeft: 10, fontSize: 11, color: "#a0a0a0", fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace" }}>
                [{currentSession.stem}]
              </span>
            )}
          </div>
          <div className="hs-winbtns">
            <button className="hs-winbtn" title="全屏 (F11, Esc 退出)"
              onClick={async () => {
                const cur = await appWindow.isFullscreen();
                await appWindow.setFullscreen(!cur);
              }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>
              </svg>
            </button>
            <button className="hs-winbtn" title="最小化"
              onClick={() => void appWindow.minimize()}>
              <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6"><path d="M5 12h14"/></svg>
            </button>
            <button className="hs-winbtn" title="最大化"
              onClick={() => void appWindow.toggleMaximize()}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="4" width="16" height="16" rx="1"/></svg>
            </button>
            <button className="hs-winbtn close" title="关闭"
              onClick={() => void appWindow.close()}>
              <svg width="12" height="12" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="hs-body">

          {/* ── Mode rail ── */}
          <div className="hs-rail">
            {/* Nav modes */}
            <ModeBtn id="data"      label="数据集"  active={view==="data"}      onClick={() => setView("data")}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <ellipse cx="12" cy="5" rx="8" ry="3"/>
                <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/>
                <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>
              </svg>
            </ModeBtn>
            <ModeBtn id="run"       label="运行"    active={view==="run"}       onClick={() => setView("run")}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </ModeBtn>
            <ModeBtn id="tasks"     label="任务"    active={view==="tasks"}     onClick={() => setView("tasks")}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M9 4h6v2H9z"/><path d="M7 4H5v16h14V4h-2"/>
                <path d="M8 11h8M8 15h5"/>
              </svg>
            </ModeBtn>
            <ModeBtn id="memory" label="记忆" active={view==="memory"} onClick={() => setView("memory")} accent="#8b5cf6">
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M3 12l7-7 4 4 4-4 3 3"/>
                <path d="M3 20h18"/>
                <circle cx="7" cy="17" r="1.8"/><circle cx="12" cy="15" r="1.8"/><circle cx="17" cy="13" r="1.8"/>
              </svg>
            </ModeBtn>
            <ModeBtn id="operators" label="算子"    active={view==="operators"} onClick={() => setView("operators")}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>
                <path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>
              </svg>
            </ModeBtn>
            <ModeBtn id="calibration" label="标定"  active={view==="calibration"} onClick={() => setView("calibration")} accent="#0891b2">
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="12" r="9"/>
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
                <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>
              </svg>
            </ModeBtn>
            <ModeBtn id="settings"  label="设置"    active={view==="settings"}  onClick={() => setView("settings")}>
              <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                <circle cx="12" cy="12" r="3"/>
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>
              </svg>
            </ModeBtn>

            {/* Bottom cluster */}
            <div className="hs-rail-bottom">
              <div className="hs-kit-badge" title="运行时">
                <span className="hs-kit-label">Kit</span>
                <span className="hs-kit-value">{runtime} · {gpuOff ? "CPU" : "GPU"}</span>
              </div>
              <button
                className="hs-run-btn"
                title="切换到运行视图"
                onClick={() => setView("run")}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              </button>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="hs-tool-btn" title="调试">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <rect x="7" y="8" width="10" height="11" rx="5"/>
                    <path d="M12 8V5M8 10L5 8M16 10l3-2M8 15H4M20 15h-4"/>
                  </svg>
                </button>
                <button className="hs-tool-btn" title="构建">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M14 7l3 3-8 8-3-3zM14 7l2-2 3 3-2 2"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* ── Content column ── */}
          <div className="hs-content-col">

            {/* Breadcrumb toolbar */}
            <div className="hs-breadcrumb">
              <span className="hs-crumb">{VIEW_LABELS[view]}</span>
              <span className="hs-crumb-sep">›</span>
              <span className="hs-crumb-leaf">{crumbLeaf}</span>
            </div>

            {/* Main content */}
            <div className="hs-content">
              <ErrorBoundary resetKey={view}>
              {view === "data" && (
                <DataView
                  currentSession={currentSession}
                  onSessionOpen={(s) => { setCurrentSession(s); setView("run"); }}
                />
              )}
              {view === "run" && (
                <RunView
                  onCrumbChange={setSubCrumb}
                  currentSession={currentSession}
                  onRequestSession={() => setView("data")}
                />
              )}
              {view === "tasks"     && <TaskView />}
              {view === "memory"    && <MemoryView />}
              {view === "operators" && <OperatorsView />}
              {view === "calibration" && (
                <CalibrationView
                  currentSession={currentSession}
                  onRequestSession={() => setView("data")}
                />
              )}
              {view === "settings"  && <SettingsView onConfigSaved={setConfig} />}
              </ErrorBoundary>
            </div>

            {/* Output pane */}
            <div className="hs-output">
              <div className="hs-output-tabs">
                <button
                  className={`hs-output-tab ${outOpen ? "active" : ""}`}
                  onClick={() => setOutOpen((v) => !v)}
                  style={{ background: outOpen ? "#fbfbfb" : "transparent", border: outOpen ? "1px solid #dcdcdc" : "none" }}
                >
                  <span className={`hs-tab-cnt ${logs.length > 0 ? "green" : ""}`}>
                    {logs.length}
                  </span>
                  <span className="hs-tab-label bold">应用输出</span>
                </button>
                <button className="hs-output-tab" style={{ background: "none", border: "none" }}>
                  <span className="hs-tab-cnt">0</span>
                  <span className="hs-tab-label">问题</span>
                </button>
                <button className="hs-output-tab" style={{ background: "none", border: "none" }}>
                  <span className="hs-tab-label">搜索结果</span>
                </button>
                <button className="hs-output-tab" style={{ background: "none", border: "none" }}>
                  <span className="hs-tab-label">编译输出</span>
                </button>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9, color: "#8a8a8a" }}>
                  <button
                    onClick={async () => {
                      // Right-click has no native context menu in this webview (Tauri
                      // disables it by default), so drag-select + right-click "复制"
                      // silently does nothing — this button is the only discoverable
                      // way to copy log output.
                      try {
                        await navigator.clipboard.writeText(logs.map((l) => l.text).join("\n"));
                        toast.success("已复制到剪贴板");
                      } catch {
                        toast.error("复制失败");
                      }
                    }}
                    disabled={logs.length === 0}
                    style={{ background: "none", border: "none", cursor: logs.length === 0 ? "default" : "pointer", color: logs.length === 0 ? "#c4c4c4" : "#8a8a8a", padding: "2px 4px" }}
                    title="复制日志"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                      <rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => setLogs([])}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#8a8a8a", padding: "2px 4px" }}
                    title="清空日志"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
                      <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>
                    </svg>
                  </button>
                  <button
                    onClick={() => setOutOpen((v) => !v)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#8a8a8a", padding: "2px 4px", fontSize: 13 }}
                  >
                    {outOpen ? "▾" : "▸"}
                  </button>
                </div>
              </div>
              {outOpen && (
                <div className="hs-output-log">
                  {logs.length === 0 ? (
                    <div style={{ color: "#a8a8a8" }}>点击运行按钮开始执行工作流…</div>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className={`hs-log-line ${l.cls}`}>{l.text}</div>
                    ))
                  )}
                  <div ref={logEndRef} />
                </div>
              )}
            </div>

            {/* Status bar */}
            <div className="hs-statusbar">
              {currentSession && (
                <span style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", fontSize: 10.5, color: "#199a3e", display: "inline-flex", alignItems: "center", gap: 5, marginRight: 4 }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
                  {currentSession.stem}
                </span>
              )}
              <div className="hs-locator">
                <span className="hs-locator-arrow">›</span>
                <input
                  value={locator}
                  onChange={(e) => setLocator(e.target.value)}
                  placeholder="输入定位符…"
                />
              </div>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#199a3e" }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                {runtime} · {gpuOff ? "CPU · GPU off" : "GPU on"}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                {running && (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "#199a3e", display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ animation: "hs-spin 1s linear infinite" }}>
                        <path d="M21 12a9 9 0 1 1-6.2-8.5"/>
                      </svg>
                      {stepLabel || "执行中"} · {progressPct}%
                    </span>
                    <div style={{ width: 150, height: 8, borderRadius: 5, background: "#d4d4d4", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${progressPct}%`, background: "linear-gradient(90deg,#4bd85e,#2ba63d)", borderRadius: 5, transition: "width .4s ease" }} />
                    </div>
                  </div>
                )}
                {!running && elapsed && (
                  <span style={{ color: "#199a3e" }}>✓ 完成 · 用时 {elapsed}s</span>
                )}
                <span>行 1, 列 1</span>
                <span>UTF-8</span>
              </div>
            </div>

          </div>
        </div>
      </div>
    </AntApp>
    </ConfigProvider>
  );
}

interface ModeBtnProps {
  id: string;
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  accent?: string;
}

function ModeBtn({ label, active, onClick, children, accent }: ModeBtnProps) {
  const accentColor = accent ?? "var(--hs-green-dim)";
  return (
    <button
      className={`hs-mode-btn ${active ? "active" : ""}`}
      onClick={onClick}
      style={active && accent ? { color: accent } : undefined}
    >
      <span className="hs-mode-bar" style={accent ? { background: accent } : undefined} />
      {children}
      <span className="hs-mode-label" style={active && accent ? { color: accent } : undefined}>{label}</span>
    </button>
  );
}
