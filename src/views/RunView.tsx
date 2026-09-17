import React from "react";
import { open } from "@tauri-apps/api/dialog";
import { api, WorkflowDetail, WorkflowSummary, JobEvent, NodeDetail, HeraSession } from "../api";
import { toast } from "../components/toast";

type StepState = "pending" | "running" | "done" | "failed";

// 只保留主流水线用得到的 5 个工作流；其他（转 bag、静止点云、拼接+抽帧合并、赋位姿 TBD 等）在 UI 中隐藏。
// 赋位姿目前由 /media/yuancaimaiyi/yuancaimaiyi/data/panorama_to_prior_poses.py 单独离线跑，
// 待接入桌面工作流后把 id 加入本集合。
const VISIBLE_WORKFLOW_IDS = new Set<string>([
  "reconstruct_pointcloud", // 激光重建
  "panorama_stitch_gpu",    // 拼接
  "calib_frame_extract",    // 抽帧
  "calib_time_sync",        // 标定（时间同步）
  // "assign_prior_poses",  // 赋位姿 — TODO: 待创建对应 workflow 后放开
]);

type SchemaProp = {
  type?: string;
  enum?: string[];
  default?: unknown;
  title?: string;
  description?: string;
  maxItems?: number;
  items?: { type?: string };
};

interface Props {
  onCrumbChange?: (s: string) => void;
  currentSession?: HeraSession | null;
  onRequestSession?: () => void;
}

/** Pick the sibling file from a HeraSession that matches the workflow's declared
 * input extension. A .hera session opens as `session.path` (.hera) but stitch-like
 * workflows require the paired `.insv` — passing the .hera path to MediaSDKTest
 * makes it silently exit 0 with no output. When the workflow declares specific
 * `input.ext` values, prefer whichever sibling matches; otherwise fall back to
 * the .hera path itself.
 */
function pickInputFromSession(
  session: HeraSession | null | undefined,
  wfInput: { type: string; ext?: string[] } | undefined,
): string {
  if (!session) return "";
  const exts = (wfInput?.ext ?? []).map((e) => e.toLowerCase());
  if (exts.length === 0) return session.path;
  const lowerPath = session.path.toLowerCase();
  if (exts.some((e) => lowerPath.endsWith(e))) return session.path;
  if (exts.includes(".insv") && session.insv_path) return session.insv_path;
  return session.path;
}

export function RunView({ onCrumbChange, currentSession, onRequestSession }: Props) {
  const [workflows, setWorkflows] = React.useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = React.useState<WorkflowDetail | null>(null);
  const [inputPath, setInputPath] = React.useState("");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const [stepStates, setStepStates] = React.useState<Record<string, StepState>>({});
  const [running, setRunning] = React.useState(false);
  const [paramData, setParamData] = React.useState<Record<string, Record<string, unknown>>>({});
  const [nodeVersions, setNodeVersions] = React.useState<Record<string, string>>({});
  const [gpuStatus, setGpuStatus] = React.useState<{ present: boolean; enabled: boolean } | null>(null);
  // 每个 step 失败时的日志路径 (由 runner StepFailed 事件带过来)。用于 UI 里"打开日志"按钮。
  const [stepLogPaths, setStepLogPaths] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    api.listWorkflows()
      .then((all) => setWorkflows(all.filter((w) => VISIBLE_WORKFLOW_IDS.has(w.id))))
      .catch(() => {});
  }, []);

  // Pre-fill input path from current session whenever session OR selected workflow
  // changes. Workflow matters here because .hera and .insv are siblings and only
  // the workflow's declared `input.ext` tells us which one this run needs.
  React.useEffect(() => {
    const picked = pickInputFromSession(currentSession, selected?.input);
    if (picked) setInputPath(picked);
  }, [currentSession?.path, currentSession?.insv_path, selected?.input]);

  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    api.onJobEvent(handleEvent).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [jobId]);

  function handleEvent(ev: JobEvent) {
    if (jobId && ev.job !== jobId) return;
    switch (ev.type) {
      case "step_start":    setStepStates((s) => ({ ...s, [ev.step!]: "running" })); break;
      case "step_complete": setStepStates((s) => ({ ...s, [ev.step!]: "done" }));    break;
      case "step_failed":
        setStepStates((s) => ({ ...s, [ev.step!]: "failed" }));
        if (ev.log_path && ev.step) {
          const p = ev.log_path;
          setStepLogPaths((m) => ({ ...m, [ev.step!]: p }));
          toast.error(`${ev.step} 失败\n日志：${p}`);
        }
        break;
      case "job_complete":  setRunning(false); break;
      case "job_failed":    setRunning(false); break;
    }
  }

  async function selectWorkflow(id: string) {
    const wf = await api.getWorkflow(id);
    setSelected(wf);
    setInputPath(pickInputFromSession(currentSession, wf.input));
    setJobId(null);
    setStepStates({});
    setStepLogPaths({});
    onCrumbChange?.(wf.name + " › 配置与执行");

    const data: Record<string, Record<string, unknown>> = {};
    const versions: Record<string, string> = {};
    for (const node of wf.nodes) {
      versions[node.id] = node.version ?? "latest";
      const defaults: Record<string, unknown> = {};
      if (node.params_schema) {
        const props = (node.params_schema as { properties?: Record<string, SchemaProp> }).properties ?? {};
        for (const [k, v] of Object.entries(props)) {
          if ("default" in v) defaults[k] = v.default;
        }
      } else {
        for (const p of node.param_schema ?? []) defaults[p.id] = p.default;
      }
      data[node.id] = { ...defaults, ...node.params };
    }
    setParamData(data);
    setNodeVersions(versions);

    const needsGpu = wf.nodes.some((n) => n.gpu === "required");
    if (needsGpu) {
      const [present, cfg] = await Promise.all([api.detectGpu(), api.getConfig()]);
      setGpuStatus({ present, enabled: cfg.runtime.gpu_enabled });
    } else {
      setGpuStatus(null);
    }
  }

  function goBack() {
    setSelected(null);
    onCrumbChange?.("");
  }

  async function browseInput() {
    if (!selected) return;
    const isDir = selected.input.type === "dir";
    const result = await open({
      directory: isDir, multiple: false,
      filters: !isDir && selected.input.ext
        ? [{ name: "Input files", extensions: selected.input.ext.map((e) => e.replace(".", "")) }]
        : undefined,
    });
    if (result) setInputPath(result as string);
  }

  const gpuBlockedReason =
    gpuStatus && !gpuStatus.present
      ? "此功能需要本机 NVIDIA GPU，当前设备未检测到可用 GPU。"
      : gpuStatus && gpuStatus.present && !gpuStatus.enabled
        ? "检测到本机 GPU，但尚未在「设置」中启用 GPU 支持。"
        : null;

  async function startRun() {
    if (!inputPath.trim() || !selected || gpuBlockedReason) return;
    // Guard against wrong-extension inputs — e.g. passing .hera to a stitch
    // workflow that expects .insv, which MediaSDKTest silently swallows.
    const allowedExts = (selected.input.ext ?? []).map((e) => e.toLowerCase());
    if (selected.input.type === "file" && allowedExts.length > 0) {
      const lp = inputPath.trim().toLowerCase();
      if (!allowedExts.some((e) => lp.endsWith(e))) {
        toast.error(`此工作流需要 ${allowedExts.join(" / ")} 文件，当前输入不匹配`);
        return;
      }
    }
    const paramOverrides: Record<string, Record<string, unknown>> = {};
    for (const node of selected.nodes) paramOverrides[node.id] = paramData[node.id] ?? {};
    const initStates: Record<string, StepState> = {};
    for (const node of selected.nodes) initStates[node.id] = "pending";
    setStepStates(initStates);
    setRunning(true);
    try {
      const jid = await api.runWorkflow(selected.id, inputPath.trim(), paramOverrides);
      setJobId(jid);
    } catch (e) {
      toast.error(`启动失败: ${e}`);
      setRunning(false);
    }
  }

  async function cancelRun() {
    if (jobId) { await api.cancelJob(jobId); setRunning(false); }
  }

  async function onVersionChange(nodeId: string, version: string) {
    setNodeVersions((v) => ({ ...v, [nodeId]: version }));
    if (!selected) return;
    try {
      const manifest = await api.operatorDescribe(
        selected.nodes.find((n) => n.id === nodeId)?.operator ?? nodeId, version,
      ) as { params_schema?: { properties?: Record<string, SchemaProp> } } | null;
      if (manifest?.params_schema?.properties) {
        const defaults: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(manifest.params_schema.properties)) {
          if ("default" in v) defaults[k] = v.default;
        }
        setParamData((d) => ({ ...d, [nodeId]: defaults }));
        setSelected((prev) => prev ? {
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === nodeId ? { ...n, params_schema: manifest.params_schema as Record<string, unknown> } : n
          ),
        } : prev);
      }
    } catch { /* ignore */ }
  }

  // ── Workflow picker ──────────────────────────────────────────────────────────
  if (!selected) {
    return (
      <div className="hs-view">
        <div className="hs-view-toolbar">
          <span className="hs-view-title">运行工作流</span>
          <span style={{ fontSize: 12, color: "#9a9a9a" }}>选择一个工作流开始配置并执行</span>
        </div>
        <div className="hs-view-body" style={{ padding: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, maxWidth: 720 }}>
            {workflows.map((wf) => (
              <WfCard key={wf.id} wf={wf} onPick={() => selectWorkflow(wf.id)} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Config + run ─────────────────────────────────────────────────────────────
  return (
    <div className="hs-view">
      <div className="hs-view-body" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 14 }}>

        {/* Back + workflow name */}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            className="hs-btn"
            style={{ height: 26, padding: "0 10px", fontSize: 12 }}
            onClick={goBack}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6"/></svg>
            返回
          </button>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{selected.name}</span>
        </div>

        {gpuBlockedReason && (
          <div style={{
            background: "rgba(207,58,63,.06)", border: "1px solid rgba(207,58,63,.25)",
            borderRadius: 6, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8,
          }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#cf3a3f" strokeWidth="2" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span style={{ fontSize: 12.5, color: "#a8323a" }}>{gpuBlockedReason}</span>
            {gpuStatus?.present && !gpuStatus.enabled && (
              <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#9a9a9a" }}>前往「设置」页开启「启用 GPU」</span>
            )}
          </div>
        )}

        {/* Input: session banner or manual path */}
        {currentSession ? (
          <div style={{ background: "rgba(65,205,82,.06)", border: "1px solid rgba(65,205,82,.25)", borderRadius: 6, padding: "10px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#199a3e" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "#199a3e" }}>当前会话</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#9a9a9a" }}>
                {selected.input.ext?.map((e) => (
                  <span key={e} className="hs-tag hs-tag-gray mono" style={{ fontSize: 10.5, marginLeft: 4 }}>{e}</span>
                ))}
              </span>
            </div>
            <div style={{ fontFamily: "'IBM Plex Mono','Cascadia Code','Courier New',monospace", fontSize: 12, color: "#333", marginBottom: 8 }}>
              {currentSession.stem}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="hs-input mono"
                style={{ flex: 1, fontSize: 11.5 }}
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                placeholder="路径…"
              />
              <button className="hs-btn" style={{ fontSize: 11.5 }} onClick={() => onRequestSession?.()}>
                更换会话
              </button>
            </div>
          </div>
        ) : (
          <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: 14 }}>
            <div style={{ fontSize: 12, color: "#6d6d6d", marginBottom: 7, display: "flex", alignItems: "center", gap: 6 }}>
              {selected.input.label}
              {selected.input.ext?.map((e) => (
                <span key={e} className="hs-tag hs-tag-gray mono" style={{ fontSize: 10.5 }}>{e}</span>
              ))}
              <button
                onClick={() => onRequestSession?.()}
                style={{ marginLeft: "auto", fontSize: 11, color: "#199a3e", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
              >
                选择会话…
              </button>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="hs-input mono"
                style={{ flex: 1 }}
                value={inputPath}
                onChange={(e) => setInputPath(e.target.value)}
                placeholder="输入路径，或点击右侧浏览…"
              />
              <button className="hs-btn" onClick={browseInput}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h5l2-2h4l2 2h5v12H3z"/></svg>
                浏览
              </button>
            </div>
          </div>
        )}

        {/* Param panels per node */}
        {selected.nodes.map((node) => (
          <NodeParamPanel
            key={node.id}
            node={node}
            version={nodeVersions[node.id] ?? node.version ?? "latest"}
            paramData={paramData[node.id] ?? {}}
            onVersionChange={(v) => onVersionChange(node.id, v)}
            onChange={(id, val) => setParamData((d) => ({
              ...d,
              [node.id]: { ...(d[node.id] ?? {}), [id]: val },
            }))}
          />
        ))}

        {/* Run / Cancel */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={startRun}
            disabled={running || !inputPath.trim() || !!gpuBlockedReason}
            style={{
              height: 32, padding: "0 16px",
              background: "linear-gradient(#4bd85e, #33bf47)",
              border: "1px solid #2ba63d", borderRadius: 5,
              fontSize: 13, fontWeight: 600, color: "#fff",
              cursor: running || !inputPath.trim() || gpuBlockedReason ? "not-allowed" : "pointer",
              display: "inline-flex", alignItems: "center", gap: 7,
              boxShadow: "0 1px 2px rgba(0,0,0,.12)", fontFamily: "inherit",
              opacity: running || !inputPath.trim() || gpuBlockedReason ? 0.5 : 1,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            运行
          </button>
          {running && (
            <>
              <button
                onClick={cancelRun}
                style={{
                  height: 32, padding: "0 14px", background: "#fff",
                  border: "1px solid #d88", borderRadius: 5, fontSize: 13,
                  color: "#c0393e", cursor: "pointer", display: "inline-flex",
                  alignItems: "center", gap: 7, fontFamily: "inherit",
                }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                取消
              </button>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#199a3e" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "hs-spin 1s linear infinite" }}>
                  <path d="M21 12a9 9 0 1 1-6.2-8.5"/>
                </svg>
                正在执行…
              </span>
            </>
          )}
        </div>

        {/* Progress steps */}
        {Object.keys(stepStates).length > 0 && (
          <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, padding: "12px 14px" }}>
            <div style={{ fontSize: 12, color: "#6d6d6d", marginBottom: 10 }}>进度</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {selected.nodes.map((node) => {
                const state = stepStates[node.id] ?? "pending";
                const stateLabel = { pending: "等待", running: "运行中", done: "完成", failed: "失败" }[state];
                const stateColor = { pending: "#c2c2c2", running: "#199a3e", done: "#199a3e", failed: "#cf3a3f" }[state];
                const logPath = stepLogPaths[node.id];
                return (
                  <div key={node.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", background: "#f7f7f7", borderRadius: 4 }}>
                    <span className={`hs-dot ${state}`} />
                    <span style={{ fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace" }}>{node.id}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: stateColor }}>{stateLabel}</span>
                    {state === "failed" && logPath && (
                      <>
                        <button
                          className="hs-btn hs-btn-ghost"
                          style={{ fontSize: 11, padding: "2px 8px" }}
                          onClick={() => api.openPath(logPath).catch(() => toast.error("无法打开日志文件"))}
                          title={logPath}
                        >
                          打开日志
                        </button>
                        <button
                          className="hs-btn hs-btn-ghost"
                          style={{ fontSize: 11, padding: "2px 8px" }}
                          onClick={() => {
                            navigator.clipboard.writeText(logPath).then(() => toast.success("已复制路径"));
                          }}
                          title={logPath}
                        >
                          复制路径
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Workflow picker card ──────────────────────────────────────────────────────

function WfCard({ wf, onPick }: { wf: WorkflowSummary; onPick: () => void }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      onClick={onPick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        cursor: "pointer", background: "#fff",
        border: `1px solid ${hovered ? "#41cd52" : "#e0e0e0"}`,
        borderRadius: 8, padding: 16,
        boxShadow: hovered ? "0 2px 10px rgba(65,205,82,.14)" : "none",
        transition: "border-color .12s, box-shadow .12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
        <span style={{ width: 30, height: 30, borderRadius: 7, background: "rgba(65,205,82,.14)", display: "flex", alignItems: "center", justifyContent: "center", color: "#199a3e" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </span>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{wf.name}</span>
      </div>
      <div style={{ fontSize: 12, color: "#7a7a7a", lineHeight: 1.5, marginBottom: 10 }}>{wf.description}</div>
      {wf.input.ext && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {wf.input.ext.map((e) => (
            <span key={e} className="hs-tag hs-tag-gray mono" style={{ fontSize: 11 }}>{e}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Node param panel (3-col native grid) ─────────────────────────────────────

interface NodeParamPanelProps {
  node: NodeDetail;
  version: string;
  paramData: Record<string, unknown>;
  onVersionChange: (v: string) => void;
  onChange: (id: string, val: unknown) => void;
}

function NodeParamPanel({ node, version, paramData, onVersionChange, onChange }: NodeParamPanelProps) {
  const schemaProps = node.params_schema
    ? (node.params_schema as { properties?: Record<string, SchemaProp> }).properties ?? {}
    : null;

  // node.param_schema is a legacy fallback array — the backend sends JSON `null`
  // (not `[]`) when the operator manifest couldn't be resolved at all (e.g. not
  // yet registered in "算子仓库", or no bundled operators/ dir in this build).
  // Guard against that so an unregistered operator shows a message instead of
  // crashing the whole page with `.map()` on null.
  const entries: Array<{ id: string; schema: SchemaProp }> = schemaProps
    ? Object.entries(schemaProps).map(([id, s]) => ({ id, schema: s }))
    : (node.param_schema ?? []).map((p) => ({
        id: p.id,
        schema: {
          type: p.type === "bool" ? "boolean" : p.type === "number[3]" ? "array" : p.type === "enum" ? "string" : p.type,
          enum: p.type === "enum" ? (p.values ?? []) : undefined,
          default: p.default,
          title: p.label ?? p.id,
          description: p.description,
          maxItems: p.type === "number[3]" ? 3 : undefined,
        } as SchemaProp,
      }));

  return (
    <div style={{ background: "#fff", border: "1px solid #e2e2e2", borderRadius: 6, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 14px", borderBottom: "1px solid #eee", background: "#f7f7f7" }}>
        <span style={{ fontSize: 12, color: "#6d6d6d" }}>{node.operator} 参数</span>
        <span className="hs-tag hs-tag-green mono">{version}</span>
        {node.available_versions.length > 0 && (
          <select
            className="hs-input"
            style={{ height: 24, padding: "0 8px", fontSize: 11.5, marginLeft: "auto", cursor: "pointer", width: 140 }}
            value={version}
            onChange={(e) => onVersionChange(e.target.value)}
          >
            {node.available_versions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        )}
      </div>
      {/* 3-column param grid */}
      {entries.length > 0 ? (
        <div style={{ padding: 14, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "14px 16px" }}>
          {entries.map(({ id, schema: s }) => {
            const isArray = s.type === "array";
            const span = isArray ? ((s.maxItems ?? 3) >= 7 ? 3 : 2) : 1;
            return (
              <label
                key={id}
                style={{ display: "flex", flexDirection: "column", gap: 5, gridColumn: span > 1 ? `span ${span}` : undefined }}
              >
                <span style={{ fontSize: 11.5, color: "#7a7a7a" }}>
                  {s.title ?? id}
                  {s.description && (
                    <span style={{ color: "#b0b0b0", fontSize: 10.5, marginLeft: 4 }}>— {s.description}</span>
                  )}
                </span>
                <ParamField
                  id={id}
                  schema={s}
                  value={paramData[id] ?? s.default}
                  onChange={(val) => onChange(id, val)}
                />
              </label>
            );
          })}
        </div>
      ) : node.available_versions.length === 0 ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "#cf3a3f" }}>
          算子「{node.operator}」尚未注册，请先前往「算子仓库」添加该算子后再运行。
        </div>
      ) : (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "#9a9a9a" }}>无可配置参数</div>
      )}
    </div>
  );
}

// ── Param field (native, no RJSF) ────────────────────────────────────────────

function ParamField({ id: _id, schema: s, value, onChange }: {
  id: string;
  schema: SchemaProp;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const isEnum   = s.type === "string" && Array.isArray(s.enum) && s.enum.length > 0;
  const isBool   = s.type === "boolean";
  const isNumber = s.type === "number" || s.type === "integer";
  const isArray  = s.type === "array";
  const arrLen   = s.maxItems ?? 3;

  if (isEnum) {
    return (
      <select
        className="hs-input"
        style={{ width: "100%", cursor: "pointer" }}
        value={String(value ?? s.default ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {s.enum!.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }

  if (isBool) {
    const checked = Boolean(value ?? s.default);
    return (
      <div
        onClick={() => onChange(!checked)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 28, cursor: "pointer" }}
      >
        <span style={{
          width: 38, height: 20, borderRadius: 10,
          background: checked ? "#2ba63d" : "#d4d4d4",
          position: "relative", display: "inline-block", transition: "background .15s", flexShrink: 0,
        }}>
          <span style={{
            position: "absolute", top: 2, left: checked ? 18 : 2,
            width: 16, height: 16, borderRadius: "50%",
            background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.3)", transition: "left .15s",
          }} />
        </span>
        <span style={{ fontSize: 12, color: "#555" }}>{checked ? "开启" : "关闭"}</span>
      </div>
    );
  }

  if (isArray) {
    const arr = Array.isArray(value) ? (value as number[]) : Array.isArray(s.default) ? (s.default as number[]) : Array(arrLen).fill(0);
    const LABELS = arrLen === 3 ? ["R", "P", "Y"] : arrLen === 7 ? ["x", "y", "z", "qx", "qy", "qz", "qw"] : Array.from({ length: arrLen }, (_, i) => String(i));
    const W = arrLen >= 7 ? 54 : 70;
    return (
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {Array.from({ length: arrLen }, (_, i) => (
          <NumberInput
            key={i}
            className="hs-input mono"
            style={{ width: W, height: 28, padding: "0 6px", textAlign: "center", fontSize: 12 }}
            title={LABELS[i]}
            placeholder={LABELS[i]}
            value={arr[i] ?? 0}
            onCommit={(n) => {
              const next = [...arr];
              while (next.length < arrLen) next.push(0);
              next[i] = n;
              onChange(next);
            }}
            step="any"
          />
        ))}
      </div>
    );
  }

  if (isNumber) {
    return (
      <NumberInput
        className="hs-input mono"
        style={{ width: "100%" }}
        value={(value ?? s.default) as number | undefined}
        onCommit={(n) => onChange(n)}
        step="any"
      />
    );
  }

  return (
    <input
      className="hs-input mono"
      style={{ width: "100%" }}
      type="text"
      value={String(value ?? s.default ?? "")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Number input with local edit buffer.
 *
 * 原生 <input type="number" value={num}> 有两个坑：
 *   1) `parseFloat("") = NaN`：清空输入框那一瞬会把上层 state clobber 成 0（如果用了 `|| 0`）
 *   2) 受控回写会吞掉中间态："0." 立刻被解析成 0 再回写成 "0"，小数点永远敲不进去
 * 这里维护一份本地字符串编辑缓冲：
 *   - 只有解析出**有限数字**（且真的变了）才 onCommit
 *   - 外部 value 变更会同步到缓冲（除非用户正在编辑一个正解析成同值的字符串）
 *   - 失焦时若缓冲无效则恢复到外部 value 显示
 */
function NumberInput({
  value, onCommit, className, style, title, placeholder, step,
}: {
  value: number | undefined;
  onCommit: (n: number) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  placeholder?: string;
  step?: string;
}) {
  const [buf, setBuf] = React.useState<string>(value == null ? "" : String(value));
  // 外部 value 变了 → 只在缓冲不能解析成同值时才刷新（避免打断用户"0."中间态）
  React.useEffect(() => {
    const parsed = parseFloat(buf);
    if (!Number.isFinite(parsed) || parsed !== value) {
      setBuf(value == null ? "" : String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      className={className}
      style={style}
      title={title}
      placeholder={placeholder}
      type="text"
      inputMode="decimal"
      value={buf}
      step={step}
      onChange={(e) => {
        const t = e.target.value;
        setBuf(t);
        const n = parseFloat(t);
        if (Number.isFinite(n) && n !== value) {
          onCommit(n);
        }
      }}
      onBlur={() => {
        const n = parseFloat(buf);
        if (!Number.isFinite(n)) {
          setBuf(value == null ? "" : String(value));
        }
      }}
    />
  );
}
