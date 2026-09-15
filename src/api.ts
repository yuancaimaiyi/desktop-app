import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open as dialogOpen } from "@tauri-apps/api/dialog";

export interface Dataset {
  id: string;
  path: string;
  file_type: string;
  size_bytes: number | null;
  meta_json: string | null;
  indexed_at: string;
}

/** A fully parsed hera recording session (3-file bundle: .hera + .insv + .session.json). */
export interface HeraSession {
  path: string;
  stem: string;
  /** Parsed from stem: "YYYY-MM-DD" */
  date: string;
  /** Parsed from stem: "HH:MM:SS" */
  time: string;
  /** Parsed from stem: second segment after timestamp */
  operator: string;
  /** Parsed from stem: remaining segments joined with "_" */
  place: string;
  hera_size: number;
  insv_path: string | null;
  insv_size: number | null;
  session_json: string | null;
  session_json_size: number | null;
}

/** Basename of a path, tolerant of both `/` (Unix) and `\` (Windows) separators —
 *  paths come from the Rust backend's `PathBuf` serialization, which is
 *  platform-native and never normalized to `/`. */
export function basename(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

/** Parent directory of a path, tolerant of both `/` and `\` separators. */
export function dirname(path: string): string {
  const parts = path.split(/[/\\]/);
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  parts.pop();
  return parts.join(sep);
}

export function parseSessionFilename(stem: string): Pick<HeraSession, "date" | "time" | "operator" | "place"> {
  const parts = stem.split("_");
  if (parts.length >= 3 && parts[0].length === 14) {
    const ts = parts[0];
    return {
      date: `${ts.slice(0,4)}-${ts.slice(4,6)}-${ts.slice(6,8)}`,
      time: `${ts.slice(8,10)}:${ts.slice(10,12)}:${ts.slice(12,14)}`,
      operator: parts[1],
      place: parts.slice(2).join("_"),
    };
  }
  return { date: "?", time: "?", operator: "?", place: stem };
}

export interface HeraDeviceInfo {
  id: number;
  name: string;
  message_count: number;
  data_bytes: number;
}

/** Parsed `.hera` binary file header (version/time range/per-device stats/extra_info). */
export interface HeraFileInfo {
  version: number;
  timestamp_start_ns: number;
  timestamp_end_ns: number;
  duration_s: number;
  devices: HeraDeviceInfo[];
  extra_info: unknown;
}

export interface Job {
  id: string;
  workflow_id: string;
  input_path: string;
  params_json: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
}

export interface Artifact {
  id: string;
  job_id: string;
  step: string;
  output_id: string;
  host_path: string;
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  input: { type: string; ext?: string[]; label: string };
}

export interface ParamSchema {
  id: string;
  type: string;
  label?: string;
  description?: string;
  values?: string[];
  default: unknown;
}

export interface NodeDetail {
  id: string;
  operator: string;
  version: string;
  available_versions: string[];
  params: Record<string, unknown>;
  params_schema?: Record<string, unknown>;
  /** `null` when the operator manifest couldn't be resolved (not yet registered, etc.) — not just possibly-empty. */
  param_schema: ParamSchema[] | null;
  /** "required" | "optional" | "none" | null (manifest unresolved) */
  gpu?: string | null;
}

export interface WorkflowDetail extends WorkflowSummary {
  nodes: NodeDetail[];
  edges: { from_node: string; from_output: string; to_node: string; to_input: string }[];
  workflow_input_to: { node: string; input: string };
}

export interface JobEvent {
  type: string;
  job: string;
  step?: string;
  text?: string;
  is_stderr?: boolean;
  image?: string;
  exit_code?: number;
  reason?: string;
  artifacts?: Artifact[];
}

export interface AppConfig {
  runtime: { container: string; gpu_enabled: boolean };
  data: { data_dir?: string; output_dir?: string; glim_config_dir?: string; storage_extract_mid360_path?: string };
  viewers: { pointcloud_viewer?: string };
  registry: { db_path: string };
}

/** Static-vs-motion judgment for a session, from IMU gyro std. A suggestion only —
 *  never auto-branch on `is_static` without letting the user confirm/override. */
export interface MotionCheckResult {
  gyro_std: [number, number, number];
  window_std_max: number;
  is_static: boolean;
  threshold: number;
  sample_count: number;
  duration_s: number;
}

/** Azimuth/elevation range image built from a point cloud — right-hand panel of
 *  the calibration point-select stage. `points` is row-major (row=elevation,
 *  col=azimuth) x,y,z triplets in the cloud's own frame, NaN for empty bins. */
export interface RangeImageResult {
  az_bins: number;
  el_bins: number;
  image_png_base64: string;
  /** Empty bins serialize as `null` (serde_json turns NaN into JSON null), not NaN. */
  points: (number | null)[];
  min_range: number;
  max_range: number;
  range_p02: number;
  range_p50: number;
  range_p98: number;
  color_min_range: number;
  color_max_range: number;
  input_point_count: number;
  valid_point_count: number;
  filtered_point_count: number;
  point_count: number;
  occupancy_ratio: number;
  /** Elevation range the image rows actually span — auto-fit to the point
   *  cloud's own data (e.g. Mid-360's real ~-7..52deg FOV), not the full ±90°. */
  el_min_deg: number;
  el_max_deg: number;
  source: "pointcloud" | "raw_time_window" | "glim_submaps" | "glim_whole_map" | "glim_whole_map_fallback";
  source_detail?: string | null;
}

/** LiDAR->camera extrinsic (rotation convention: R = Rx(roll)·Ry(pitch)·Rz(yaw),
 *  matched to the existing spatial-memory extrinsic.json / p3_bind_pose.py —
 *  NOT the same convention as this app's own operator mounting_rpy params). */
export interface Extrinsic {
  tx: number; ty: number; tz: number;
  roll_deg: number; pitch_deg: number; yaw_deg: number;
}

export interface CalibPointPair {
  u: number; v: number;
  x: number; y: number; z: number;
  /** §7: fixed 0 for static scenes, scrubbed timeline position (ns) for motion. */
  frame_timestamp_ns?: number | null;
}

/** LiDAR pose in the GLIM world/map frame at some trajectory timestamp. */
export interface Pose {
  pos: [number, number, number];
  quat_xyzw: [number, number, number, number];
}

/** One timeline frame's point pairs + the LiDAR pose there (null for static). */
export interface FrameGroup {
  frame_pose: Pose | null;
  pairs: CalibPointPair[];
}

export interface TrajectoryInfo {
  t_min: number;
  t_max: number;
  count: number;
}

export interface SolveResult {
  extrinsic: Extrinsic;
  residuals_deg: number[];
  iterations: number;
  converged: boolean;
  rms_residual_deg: number;
}

export interface OfficialOperator {
  id: string;
  name: string;
  description: string;
  imageRef: string;
  latestTag: string;
  /** Full operator manifest JSON. Passed to operator_add to bypass --describe for images
   *  that use ROS entrypoints and don't implement the self-describe protocol. */
  manifest: Record<string, unknown>;
}

export const OFFICIAL_OPERATORS: OfficialOperator[] = [
  {
    id: "glim-recon",
    name: "GLIM 激光重建",
    description: "基于 GLIM 框架的 LiDAR-IMU 点云重建算子，支持 Mid-360 / Livox 传感器",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-runner",
    latestTag: "r0.6",
    manifest: {
      spec: "1",
      id: "glim-recon",
      name: "GLIM 激光重建",
      version: "r0.6",
      gpu: "optional",
      mounts: [
        {
          id: "config",
          host: "",
          container: "/glim/config",
          mode: "rw",
          image_config_path: "/opt/glim_offline/share/glim/config",
        },
      ],
      inputs: [
        { id: "scan", type: "file", ext: [".hera", ".db3"], container: "/data/input" },
      ],
      outputs: [
        { id: "map", type: "dir", container: "/output/map" },
      ],
      params_schema: {
        type: "object",
        properties: {
          window:                  { type: "number",  default: 0.1,        title: "时间窗口(秒)",        description: "点云积累时间窗口（秒）" },
          mode:                    { type: "string",  enum: ["cpu","gpu"],  default: "cpu",               title: "计算模式" },
          imu_topic:               { type: "string",  default: "/lidar/mid360/imu",             title: "IMU Topic",    description: "仅 .db3 输入时使用" },
          points_topic:            { type: "string",  default: "/lidar/mid360/point_cloud2",    title: "点云 Topic",   description: "仅 .db3 输入时使用" },
          t_lidar_imu:             { type: "array",   items: { type: "number" }, minItems: 7, maxItems: 7, default: [0,0,0,0,0,0,1], title: "激光-IMU 外参 (TUM: x y z qx qy qz qw)", description: "Mid-360 同轴安装默认 identity" },
          mounting_rpy:            { type: "array",   items: { type: "number" }, minItems: 3, maxItems: 3, default: [0,0,0], title: "安装角 RPY (度, ZYX)", description: "正置=[0,0,0]；倒置 pitch180=[0,180,0]" },
          imu_acc_noise:           { type: "number",  default: 0.05,       title: "IMU 加速度噪声",      description: "调高可降低 IMU 权重" },
          keyframe_strategy:       { type: "string",  enum: ["OVERLAP","DISPLACEMENT"], default: "OVERLAP", title: "关键帧策略", description: "DISPLACEMENT 适用于静止/短距场景" },
          keyframe_interval_trans: { type: "number",  default: 1.0,        title: "关键帧间距(m)",       description: "DISPLACEMENT 策略下最小位移（米）" },
        },
      },
      params_bindings: {
        window:                  { mode: "arg", flag: "--window" },
        mode:                    { mode: "config_switch_suffix", file: "config.json", parent: "global", keys: ["config_odometry","config_sub_mapping","config_global_mapping"] },
        imu_topic:               { mode: "arg", flag: "--imu-topic",    condition: "input_ext=.db3" },
        points_topic:            { mode: "arg", flag: "--points-topic", condition: "input_ext=.db3" },
        t_lidar_imu:             { mode: "config_patch", file: "config_sensors.json", jsonpath: "$.sensors.T_lidar_imu" },
        mounting_rpy:            { mode: "config_rpy_patch", file: "config_sensors.json", t_field: "$.sensors.T_lidar_imu", rpy_field: "$.sensors.lidar_mounting_rpy" },
        imu_acc_noise:           { mode: "config_patch", file: "config_sensors.json", jsonpath: "$.sensors.imu_acc_noise" },
        keyframe_strategy:       { mode: "config_patch", file: "config_sub_mapping_cpu.json", jsonpath: "$.sub_mapping.keyframe_update_strategy" },
        keyframe_interval_trans: { mode: "config_patch", file: "config_sub_mapping_cpu.json", jsonpath: "$.sub_mapping.keyframe_update_interval_trans" },
      },
      exit_codes_ok: [0, 139],
      command: "glim_offline {in:scan} -c /glim/config -o {out:map} --window {param:window} {?db3:--imu-topic {param:imu_topic} --points-topic {param:points_topic}}",
    },
  },
  {
    id: "hera-convert",
    name: "Hera 格式转换",
    description: "将 .hera 文件转换为 ROS2 .db3 rosbag，用于回放与调试",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-convert",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "hera-convert",
      name: "Hera→ROS bag",
      version: "latest",
      gpu: "none",
      mounts: [],
      inputs: [
        { id: "raw", type: "file", ext: [".hera"], container: "/data/input" },
      ],
      outputs: [
        { id: "bag", type: "file", container: "/output/out.db3" },
      ],
      params_schema: {
        type: "object",
        properties: {
          window:       { type: "number",  default: 0.1,                       title: "时间窗口(秒)" },
          imu_topic:    { type: "string",  default: "/lidar/mid360/imu",       title: "IMU Topic" },
          points_topic: { type: "string",  default: "/lidar/mid360/point_cloud2", title: "点云 Topic" },
          verbose:      { type: "boolean", default: false,                      title: "详细输出" },
        },
      },
      params_bindings: {
        window:       { mode: "arg", flag: "--window" },
        imu_topic:    { mode: "arg", flag: "--imu-topic" },
        points_topic: { mode: "arg", flag: "--points-topic" },
        verbose:      { mode: "arg", flag: "-v" },
      },
      command: "hera_to_rosbag {in:raw} -o {out:bag} --window {param:window} --imu-topic {param:imu_topic} --points-topic {param:points_topic} {param:verbose}",
    },
  },
  {
    id: "glim-export-pcd",
    name: "点云导出",
    description: "将 GLIM 重建输出的地图目录导出为点云文件 (.ply/.pcd/.csv)",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-export-pcd",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "glim-export-pcd",
      name: "点云导出",
      version: "latest",
      gpu: "none",
      mounts: [],
      inputs: [
        { id: "map", type: "dir", container: "/input/map" },
      ],
      outputs: [
        { id: "cloud", type: "file", container: "/output/map_export.ply" },
      ],
      params_schema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["ply", "pcd", "csv"], default: "ply", title: "输出格式" },
        },
      },
      params_bindings: {
        format: { mode: "arg", flag: "--format" },
      },
      command: "python3 /opt/scripts/export_map_pcd.py /input/map -o {out:cloud} --format {param:format}",
    },
  },
  {
    id: "panorama-stitch",
    name: "全景拼接",
    description: "输入 .insv 双鱼眼视频文件（与 .hera 会话同目录），通过阿里云 FC GPU 服务用 Insta360 MediaSDK 拼接为全景视频（无需本地 GPU）",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-panorama-stitch",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "panorama-stitch",
      name: "全景拼接",
      version: "latest",
      gpu: "none",
      mounts: [],
      inputs: [
        { id: "insv", type: "file", ext: [".insv"], container: "/data/input" },
      ],
      outputs: [
        { id: "panorama", type: "file", container: "/output/panorama.mp4" },
      ],
      params_schema: {
        type: "object",
        properties: {
          stitch_type: { type: "string", enum: ["optflow", "template", "dynamicstitch", "aistitch"], default: "optflow", title: "拼接算法", description: "optflow: 光流拼接（默认，质量最好）；template: 模板拼接（最快）；dynamicstitch: 动态拼接；aistitch: AI 拼接" },
          output_size: { type: "string", default: "3840x1920", title: "输出分辨率", description: "格式 宽x高，如 3840x1920" },
          flowstate:   { type: "boolean", default: false, title: "FlowState 防抖" },
          h265:        { type: "boolean", default: false, title: "H265 编码", description: "关闭则使用 H264" },
          colorplus:   { type: "boolean", default: false, title: "ColorPlus 色彩增强" },
          denoise:     { type: "boolean", default: false, title: "降噪" },
          deflicker:   { type: "boolean", default: false, title: "去闪烁" },
          defringe:    { type: "boolean", default: false, title: "去紫边" },
          verbose:     { type: "boolean", default: false, title: "详细日志" },
        },
      },
      params_bindings: {
        stitch_type: { mode: "arg", flag: "--stitch-type" },
        output_size: { mode: "arg", flag: "--output-size" },
        flowstate:   { mode: "arg", flag: "--flowstate" },
        h265:        { mode: "arg", flag: "--h265" },
        colorplus:   { mode: "arg", flag: "--colorplus" },
        denoise:     { mode: "arg", flag: "--denoise" },
        deflicker:   { mode: "arg", flag: "--deflicker" },
        defringe:    { mode: "arg", flag: "--defringe" },
        verbose:     { mode: "arg", flag: "--verbose" },
      },
      command: "hera_stitch_remote.py {in:insv} {out:panorama} --stitch-type {param:stitch_type} --output-size {param:output_size} {param:flowstate} {param:h265} {param:colorplus} {param:denoise} {param:deflicker} {param:defringe} {param:verbose}",
    },
  },
  {
    id: "panorama-stitch-gpu",
    name: "全景拼接（本机 GPU）",
    description: "输入 .insv 双鱼眼视频文件（与 .hera 会话同目录），在本机 NVIDIA GPU 上直接用 MediaSDKTest 拼接为全景视频，不经过网络/OSS/云端服务",
    imageRef: "crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/hera-panorama-stitch-gpu",
    latestTag: "latest",
    manifest: {
      spec: "1",
      id: "panorama-stitch-gpu",
      name: "全景拼接（本机 GPU）",
      version: "latest",
      gpu: "required",
      mounts: [],
      inputs: [
        { id: "insv", type: "file", ext: [".insv"], container: "/data/input" },
      ],
      outputs: [
        { id: "panorama", type: "file", container: "/output/panorama.mp4" },
      ],
      params_schema: {
        type: "object",
        properties: {
          stitch_type: { type: "string", enum: ["optflow", "template", "dynamicstitch", "aistitch"], default: "optflow", title: "拼接算法", description: "optflow: 光流拼接（默认，质量最好）；template: 模板拼接（最快）；dynamicstitch: 动态拼接；aistitch: AI 拼接" },
          output_size: { type: "string", default: "3840x1920", title: "输出分辨率", description: "格式 宽x高，如 3840x1920" },
          flowstate:   { type: "boolean", default: false, title: "FlowState 防抖" },
          h265:        { type: "boolean", default: false, title: "H265 编码", description: "关闭则使用 H264" },
          colorplus:   { type: "boolean", default: false, title: "ColorPlus 色彩增强" },
          denoise:     { type: "boolean", default: false, title: "降噪" },
          deflicker:   { type: "boolean", default: false, title: "去闪烁" },
          defringe:    { type: "boolean", default: false, title: "去紫边" },
          verbose:     { type: "boolean", default: false, title: "详细日志" },
        },
      },
      params_bindings: {
        stitch_type: { mode: "arg", flag: "-stitch_type" },
        output_size: { mode: "arg", flag: "-output_size" },
        flowstate:   { mode: "arg", flag: "-enable_flowstate" },
        h265:        { mode: "arg", flag: "-enable_h265_encoder" },
        colorplus:   { mode: "arg", flag: "-enable_colorplus" },
        denoise:     { mode: "arg", flag: "-enable_denoise" },
        deflicker:   { mode: "arg", flag: "-enable_deflicker" },
        defringe:    { mode: "arg", flag: "-enable_defringe" },
        verbose:     { mode: "arg", flag: "-enable_debug_info" },
      },
      command: "MediaSDKTest -inputs {in:insv} -output {out:panorama} -model_root_dir /usr/models -stitch_type {param:stitch_type} -output_size {param:output_size} {param:flowstate} {param:h265} {param:colorplus} {param:denoise} {param:deflicker} {param:defringe} {param:verbose}",
    },
  },
];

export interface OperatorVersionInfo {
  id: string;
  version: string;
  image_ref: string;
  image_digest: string;
  source: string;
  added_at: string;
}

export interface OperatorSummary {
  id: string;
  versions: OperatorVersionInfo[];
}

export const api = {
  listDatasets: () => invoke<Dataset[]>("list_datasets"),
  scanDir: (path: string) => invoke<number>("scan_dir", { path }),

  openHeraSession: async (path: string): Promise<HeraSession> => {
    const raw = await invoke<{
      path: string; stem: string; hera_size: number;
      insv_path: string | null; insv_size: number | null;
      session_json: string | null; session_json_size: number | null;
    }>("open_hera_session", { path });
    return { ...raw, ...parseSessionFilename(raw.stem) };
  },
  heraFileInfo: (path: string) => invoke<HeraFileInfo>("hera_file_info", { path }),
  checkSessionMotion: (heraPath: string, threshold?: number) =>
    invoke<MotionCheckResult>("check_session_motion", { heraPath, threshold: threshold ?? null }),
  buildRangeImage: (pointcloudPath: string, azBins: number, elBins: number, invertElevation: boolean, framePose?: Pose | null) =>
    invoke<RangeImageResult>("build_range_image", { pointcloudPath, azBins, elBins, invertElevation, framePose: framePose ?? null }),
  buildRangeImageWindowed: (rawPointsPath: string, tCenterSec: number, windowSec: number, azBins: number, elBins: number, invertElevation: boolean) =>
    invoke<RangeImageResult>("build_range_image_windowed", { rawPointsPath, tCenterSec, windowSec, azBins, elBins, invertElevation }),
  /** GLIM-map time-windowed source — only the submaps overlapping the window,
   *  instead of reprojecting the whole session's aggregated map. See
   *  hera_runner::submap for the underlying (reverse-engineered) format. */
  buildRangeImageGlimWindowed: (mapDir: string, tCenterSec: number, windowSec: number, framePose: Pose, azBins: number, elBins: number, invertElevation: boolean) =>
    invoke<RangeImageResult>("build_range_image_glim_windowed", { mapDir, tCenterSec, windowSec, framePose, azBins, elBins, invertElevation }),
  /** First Mid360 sample's `timestamp_host_ns` from a raw points CSV — the
   *  zero-anchor `multi_source_synchronizer`'s offset_sec is relative to. */
  firstTimestampHostNs: (rawPointsPath: string) => invoke<number>("first_timestamp_host_ns", { rawPointsPath }),
  loadTrajectory: (path: string) => invoke<TrajectoryInfo>("load_trajectory", { path }),
  interpolatePose: (path: string, tQuery: number) => invoke<Pose | null>("interpolate_pose", { path, tQuery }),
  readFileBase64: (path: string) => invoke<string>("read_file_base64", { path }),
  readTextFileOpt: (path: string) => invoke<string | null>("read_text_file_opt", { path }),

  solveExtrinsic: (frames: FrameGroup[], initialExtrinsic: Extrinsic, erpWidth: number, erpHeight: number) =>
    invoke<SolveResult>("solve_extrinsic", { frames, initialExtrinsic, erpWidth, erpHeight }),
  projectOverlay: (pointcloudPath: string, extrinsic: Extrinsic, panoramaPath: string, subsample: number, framePose?: Pose | null) =>
    invoke<string>("project_overlay", { pointcloudPath, extrinsic, panoramaPath, subsample, framePose: framePose ?? null }),
  saveExtrinsic: (sessionPath: string, extrinsic: Extrinsic, pointPairs: CalibPointPair[], residualsDeg: number[], note?: string) =>
    invoke<string>("save_extrinsic", { sessionPath, extrinsic, pointPairs, residualsDeg, note: note ?? null }),
  listWorkflows: () => invoke<WorkflowSummary[]>("list_workflows"),
  getWorkflow: (id: string) => invoke<WorkflowDetail>("get_workflow", { id }),
  runWorkflow: (
    workflowId: string,
    inputPath: string,
    paramOverrides: Record<string, Record<string, unknown>>
  ) => invoke<string>("run_workflow", { workflowId, inputPath, paramOverrides }),
  cancelJob: (jobId: string) => invoke<void>("cancel_job", { jobId }),
  listJobs: () => invoke<Job[]>("list_jobs"),
  jobArtifacts: (jobId: string) => invoke<Artifact[]>("job_artifacts", { jobId }),
  findReusablePanorama: (inputPath: string) => invoke<Artifact[] | null>("find_reusable_panorama", { inputPath }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  getConfig: () => invoke<AppConfig>("get_config"),
  setConfig: (config: AppConfig) => invoke<void>("set_config", { config }),
  onJobEvent: (cb: (e: JobEvent) => void) =>
    listen<JobEvent>("job-event", (e) => cb(e.payload)),

  pickFile: (extensions?: string[]) =>
    dialogOpen({
      multiple: false,
      filters: extensions?.length
        ? [{ name: "Files", extensions }]
        : undefined,
    }) as Promise<string | null>,

  pickFolder: () =>
    dialogOpen({ directory: true, multiple: false }) as Promise<string | null>,

  /** Resolve a tool: absolute path is checked for existence; a bare command
   *  name is looked up on PATH (PATHEXT too, on Windows). */
  resolveTool: (tool: string) => invoke<boolean>("resolve_tool", { tool }),

  /** Whether a real, working NVIDIA GPU is present (`nvidia-smi` succeeds). */
  detectGpu: () => invoke<boolean>("detect_gpu"),

  jobProvenance: (jobId: string) => invoke<unknown[]>("job_provenance", { jobId }),

  operatorAdd: (imageRef: string, tarPath?: string, manifestJson?: string) =>
    invoke<unknown>("operator_add", { imageRef, tarPath: tarPath ?? null, manifestJson: manifestJson ?? null }),
  operatorList: () => invoke<OperatorSummary[]>("operator_list"),
  operatorDescribe: (id: string, version: string) =>
    invoke<unknown>("operator_describe", { id, version }),
  operatorRemove: (id: string, version: string) =>
    invoke<void>("operator_remove", { id, version }),
};
