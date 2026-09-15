import React from "react";
import { Modal } from "antd";
import { open as dialogOpen } from "@tauri-apps/api/dialog";
import { api, OperatorSummary, OFFICIAL_OPERATORS, OfficialOperator } from "../api";
import { toast } from "../components/toast";

// ── helpers ────────────────────────────────────────────────────────────────────

function fullImageRef(op: OfficialOperator) {
  return `${op.imageRef}:${op.latestTag}`;
}

// ── component ─────────────────────────────────────────────────────────────────

export function OperatorsView() {
  const [operators, setOperators] = React.useState<OperatorSummary[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [imageRef, setImageRef] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  // track which official operator is being pulled: id -> "pulling" | "done" | null
  const [pullState, setPullState] = React.useState<Record<string, "pulling" | "done">>({});
  const [manifestModal, setManifestModal] = React.useState<unknown>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<{ id: string; version: string } | null>(null);

  React.useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setOperators(await api.operatorList()); }
    catch (e) { toast.error(`加载算子列表失败: ${e}`); }
    finally { setLoading(false); }
  }

  async function addFromRef(ref?: string) {
    const r = (ref ?? imageRef).trim();
    if (!r) return;
    setAdding(true);
    try {
      const manifest = await api.operatorAdd(r);
      toast.success(`算子已注册: ${(manifest as { id?: string })?.id ?? r}`);
      if (!ref) setImageRef("");
      await load();
    } catch (e) { toast.dockerError(String(e), "算子注册失败"); }
    finally { setAdding(false); }
  }

  async function addFromTar() {
    const file = await dialogOpen({ multiple: false, filters: [{ name: "Docker tar", extensions: ["tar"] }] });
    if (!file) return;
    setAdding(true);
    try {
      const manifest = await api.operatorAdd("", file as string, undefined);
      toast.success(`算子已从 tar 注册: ${(manifest as { id?: string })?.id ?? "unknown"}`);
      await load();
    } catch (e) { toast.dockerError(String(e), "tar 导入失败"); }
    finally { setAdding(false); }
  }

  async function pullOfficial(op: OfficialOperator) {
    const ref = fullImageRef(op);
    setPullState((s) => ({ ...s, [op.id]: "pulling" }));
    try {
      const manifest = await api.operatorAdd(ref, undefined, JSON.stringify(op.manifest));
      toast.success(`${op.name} 已注册: ${(manifest as { id?: string })?.id ?? ref}`);
      setPullState((s) => ({ ...s, [op.id]: "done" }));
      await load();
    } catch (e) {
      toast.dockerError(String(e), `${op.name} 拉取失败`);
      setPullState((s) => { const n = { ...s }; delete n[op.id]; return n; });
    }
  }

  async function remove(id: string, version: string) {
    try {
      await api.operatorRemove(id, version);
      toast.success(`已删除 ${id}@${version}`);
      await load();
    } catch (e) { toast.error(`删除失败: ${e}`); }
    setConfirmDelete(null);
  }

  async function showManifest(id: string, version: string) {
    try { setManifestModal(await api.operatorDescribe(id, version)); }
    catch (e) { toast.error(`获取 manifest 失败: ${e}`); }
  }

  // Map id -> installed versions for quick lookup
  const installedMap = React.useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const op of operators) m[op.id] = op.versions.map((v) => v.version);
    return m;
  }, [operators]);

  return (
    <div className="hs-view">

      {/* ── Toolbar ── */}
      <div className="hs-view-toolbar">
        <span className="hs-view-title">算子仓库</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <input
            className="hs-input mono"
            style={{ width: 300 }}
            value={imageRef}
            onChange={(e) => setImageRef(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addFromRef()}
            placeholder="输入镜像地址 (如 image:tag)…"
            disabled={adding}
          />
          <button className="hs-btn hs-btn-primary" onClick={() => addFromRef()} disabled={adding || !imageRef.trim()}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
            {adding ? "添加中…" : "添加"}
          </button>
          <button className="hs-btn" onClick={addFromTar} disabled={adding}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            导入 tar
          </button>
        </div>
      </div>

      <div className="hs-view-body" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>

        {/* ── Official catalog ── */}
        <section>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6d6d6d", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
            官方算子
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {OFFICIAL_OPERATORS.map((op) => (
              <OfficialOpCard
                key={op.id}
                op={op}
                installedVersions={installedMap[op.id] ?? []}
                pullStatus={pullState[op.id] ?? null}
                onPull={() => pullOfficial(op)}
              />
            ))}
          </div>
        </section>

        {/* ── Installed operators ── */}
        <section>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#6d6d6d", marginBottom: 10, display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/></svg>
            已安装算子
          </div>

          {loading ? (
            <div style={{ padding: 24, textAlign: "center", color: "#9a9a9a", fontSize: 12 }}>加载中…</div>
          ) : operators.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#9a9a9a" }}>
              <div style={{ fontSize: 13 }}>暂无已注册算子</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>从上方「官方算子」下载，或手动输入镜像地址添加</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {operators.map((op) => (
                <InstalledOpCard
                  key={op.id}
                  op={op}
                  onView={showManifest}
                  onDelete={(id, ver) => setConfirmDelete({ id, version: ver })}
                />
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Manifest modal */}
      <Modal
        title="operator.json manifest"
        open={manifestModal !== null}
        onCancel={() => setManifestModal(null)}
        footer={null}
        width={680}
      >
        <pre style={{ background: "#f8f8f8", border: "1px solid #e4e4e4", padding: 16, borderRadius: 4, fontSize: 12, overflow: "auto", maxHeight: 480, color: "#333" }}>
          {JSON.stringify(manifestModal, null, 2)}
        </pre>
      </Modal>

      {/* Confirm delete */}
      <Modal
        title="确认删除"
        open={confirmDelete !== null}
        onOk={() => confirmDelete && remove(confirmDelete.id, confirmDelete.version)}
        onCancel={() => setConfirmDelete(null)}
        okText="删除" cancelText="取消"
        okButtonProps={{ danger: true }}
        width={400}
      >
        <p style={{ fontSize: 13 }}>
          确认删除 <code style={{ fontFamily: "'IBM Plex Mono', monospace" }}>{confirmDelete?.id}@{confirmDelete?.version}</code>？
        </p>
      </Modal>
    </div>
  );
}

// ── Official operator card ─────────────────────────────────────────────────────

interface OfficialOpCardProps {
  op: OfficialOperator;
  installedVersions: string[];
  pullStatus: "pulling" | "done" | null;
  onPull: () => void;
}

function OfficialOpCard({ op, installedVersions, pullStatus, onPull }: OfficialOpCardProps) {
  const isInstalled = installedVersions.includes(op.latestTag) || installedVersions.includes("latest");
  const isPulling   = pullStatus === "pulling";

  return (
    <div className="hs-panel" style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px" }}>
      {/* Icon */}
      <div style={{ width: 36, height: 36, borderRadius: 8, background: "rgba(65,205,82,.12)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#199a3e" strokeWidth="1.8">
          <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/>
          <path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>
        </svg>
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{op.name}</span>
          <span className="hs-tag hs-tag-green mono">{op.latestTag}</span>
          {isInstalled && (
            <span className="hs-tag hs-tag-blue" style={{ fontSize: 10.5 }}>已安装</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: "#7a7a7a", marginBottom: 3 }}>{op.description}</div>
        <div style={{ fontSize: 11, color: "#a0a0a0", fontFamily: "'IBM Plex Mono', monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {fullImageRef(op)}
        </div>
      </div>

      {/* Action */}
      <div style={{ flexShrink: 0 }}>
        {isPulling ? (
          <button className="hs-btn hs-btn-sm" disabled style={{ gap: 6 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "hs-spin 1s linear infinite" }}>
              <path d="M21 12a9 9 0 1 1-6.2-8.5"/>
            </svg>
            拉取中…
          </button>
        ) : isInstalled ? (
          <button className="hs-btn hs-btn-sm" onClick={onPull} title="重新拉取以更新到最新版本">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
            检查更新
          </button>
        ) : (
          <button className="hs-btn hs-btn-primary hs-btn-sm" onClick={onPull}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            下载
          </button>
        )}
      </div>
    </div>
  );
}

// ── Installed operator card ────────────────────────────────────────────────────

interface InstalledOpCardProps {
  op: OperatorSummary;
  onView: (id: string, version: string) => void;
  onDelete: (id: string, version: string) => void;
}

function InstalledOpCard({ op, onView, onDelete }: InstalledOpCardProps) {
  return (
    <div className="hs-panel">
      <div className="hs-panel-hd">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
        <span style={{ fontWeight: 600, fontSize: 13, fontFamily: "'IBM Plex Mono', monospace" }}>{op.id}</span>
        <span style={{ fontSize: 11.5, color: "#9a9a9a" }}>{op.versions.length} 个版本</span>
      </div>
      <div className="hs-panel-bd" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {op.versions.map((v) => (
          <div key={v.version} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "#fafafa", border: "1px solid #eee", borderRadius: 5 }}>
            <span className="hs-tag hs-tag-green mono">{v.version}</span>
            <span style={{ fontSize: 11.5, color: "#777", fontFamily: "'IBM Plex Mono', monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {v.image_ref}
            </span>
            <span className={`hs-tag ${v.source === "tar" ? "hs-tag-amber" : "hs-tag-green"}`} style={{ fontSize: 10.5 }}>
              {v.source}
            </span>
            <span style={{ fontSize: 11, color: "#a0a0a0" }}>
              {new Date(v.added_at).toLocaleString("zh-CN")}
            </span>
            <button className="hs-btn hs-btn-sm" onClick={() => onView(op.id, v.version)}>查看</button>
            <button
              className="hs-btn hs-btn-sm"
              style={{ width: 26, padding: 0, justifyContent: "center", borderColor: "#e0bcbc", color: "#c0393e" }}
              onClick={() => onDelete(op.id, v.version)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
