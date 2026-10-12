// panorama_colorize v0.2: build a dense RGB cloud by (1) aggregating all raw
// scans into a world-frame geometry cloud and voxel-downsampling, then
// (2) colouring each voxel-point exactly once from the spatially-nearest
// panorama (no RGB averaging — preserves full panorama sharpness).
//
// Why not per-scan colour + voxel average: multiple scans view the same wall
// point from slightly different camera positions, so each contributes a
// slightly offset RGB; averaging in VoxelGrid blurs sharp features (AprilTag,
// text). Colouring each final point once from a chosen pano keeps native
// panorama resolution.
//
// Inputs:
//   <map_dir>/raw_frames/*.bin
//   <map_dir>/raw_frames/t_imu_lidar.txt
//   <map_dir>/traj_lidar.txt
//   <pano_dir>/frames/*.jpg
//   <pano_dir>/prior_poses.txt
//
// Usage:
//   panorama_colorize <map_dir> <pano_dir> <output.ply> [voxel=0.02] [max_depth=30] [lat_cutoff=30]
//
// lat_cutoff (degrees): mask panorama poles. Mid360 LiDAR body occupies the
// Insta panorama's bottom center (±45° cone below the camera). lat_cutoff=30°
// filters out points projecting to |lat| > 60° so they don't get coloured from
// the LiDAR body pixels. Lower = less filtering (keep more ground points but
// risk colouring from LiDAR body); higher = cleaner but sparser ground.
// Typical: 20° (most coverage) → 30° (balanced) → 45° (strict).

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <sstream>
#include <vector>
#include <unordered_map>
#include <numeric>

#include <Eigen/Dense>
#include <Eigen/Geometry>

#include <glim/common/cloud_deskewing.hpp>

#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>

#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl/filters/voxel_grid.h>
#include <pcl/kdtree/kdtree_flann.h>
#include <pcl/io/ply_io.h>

namespace fs = std::filesystem;

// ───── Common data types ────────────────────────────────────────────────────

struct ScanData {
  double base_stamp = 0.0;
  std::vector<Eigen::Vector4d> points;
  std::vector<double> rel_times;
  std::vector<float>  intensities;
  bool has_intensity = false;
  std::vector<double> imu_times;
  std::vector<Eigen::Isometry3d> imu_poses;
};

struct Trajectory {
  std::vector<double> ts;
  std::vector<Eigen::Vector3d> trans;
  std::vector<Eigen::Quaterniond> quats;
};

struct PanoFrame {
  std::string image_path;
  double host_sec = 0.0;
  Eigen::Isometry3d T_world_cam = Eigen::Isometry3d::Identity();
  // lazy loaded
  mutable cv::Mat image_cache;
};

// ───── File readers (same as build_dense_cloud) ─────────────────────────────

static bool read_scan(const fs::path& path, ScanData& out) {
  std::ifstream ifs(path, std::ios::binary);
  if (!ifs) return false;
  double base_stamp;
  uint32_t n_points, flags, n_imu, reserved;
  ifs.read(reinterpret_cast<char*>(&base_stamp), 8);
  ifs.read(reinterpret_cast<char*>(&n_points),   4);
  ifs.read(reinterpret_cast<char*>(&flags),      4);
  ifs.read(reinterpret_cast<char*>(&n_imu),      4);
  ifs.read(reinterpret_cast<char*>(&reserved),   4);
  if (!ifs) return false;

  out.base_stamp = base_stamp;
  out.has_intensity = (flags & 1u) != 0;
  out.points.resize(n_points);
  out.rel_times.resize(n_points);
  if (out.has_intensity) out.intensities.resize(n_points);

  for (uint32_t i = 0; i < n_points; i++) {
    float xyz[3]; float rt;
    ifs.read(reinterpret_cast<char*>(xyz), 12);
    ifs.read(reinterpret_cast<char*>(&rt), 4);
    out.points[i] = Eigen::Vector4d(xyz[0], xyz[1], xyz[2], 1.0);
    out.rel_times[i] = rt;
    if (out.has_intensity) {
      float it; ifs.read(reinterpret_cast<char*>(&it), 4);
      out.intensities[i] = it;
    }
  }
  out.imu_times.resize(n_imu);
  out.imu_poses.resize(n_imu);
  for (uint32_t i = 0; i < n_imu; i++) {
    double t; float tx,ty,tz,qx,qy,qz,qw;
    ifs.read(reinterpret_cast<char*>(&t), 8);
    ifs.read(reinterpret_cast<char*>(&tx), 4); ifs.read(reinterpret_cast<char*>(&ty), 4);
    ifs.read(reinterpret_cast<char*>(&tz), 4); ifs.read(reinterpret_cast<char*>(&qx), 4);
    ifs.read(reinterpret_cast<char*>(&qy), 4); ifs.read(reinterpret_cast<char*>(&qz), 4);
    ifs.read(reinterpret_cast<char*>(&qw), 4);
    out.imu_times[i] = t;
    Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
    T.translation() << tx, ty, tz;
    T.linear() = Eigen::Quaterniond(qw, qx, qy, qz).toRotationMatrix();
    out.imu_poses[i] = T;
  }
  return true;
}

static Trajectory load_traj(const fs::path& path) {
  Trajectory tr;
  std::ifstream ifs(path);
  if (!ifs) throw std::runtime_error("cannot open " + path.string());
  std::string line;
  while (std::getline(ifs, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::istringstream ss(line);
    double t, tx, ty, tz, qx, qy, qz, qw;
    if (!(ss >> t >> tx >> ty >> tz >> qx >> qy >> qz >> qw)) continue;
    tr.ts.push_back(t);
    tr.trans.emplace_back(tx, ty, tz);
    tr.quats.emplace_back(qw, qx, qy, qz);
  }
  std::vector<size_t> idx(tr.ts.size());
  std::iota(idx.begin(), idx.end(), 0);
  std::sort(idx.begin(), idx.end(), [&](size_t a, size_t b){ return tr.ts[a] < tr.ts[b]; });
  Trajectory s;
  for (auto i : idx) { s.ts.push_back(tr.ts[i]); s.trans.push_back(tr.trans[i]); s.quats.push_back(tr.quats[i]); }
  return s;
}

static Eigen::Isometry3d load_t_imu_lidar(const fs::path& p) {
  std::ifstream ifs(p);
  if (!ifs) throw std::runtime_error("cannot open " + p.string());
  std::string line;
  double tx,ty,tz,qx,qy,qz,qw;
  while (std::getline(ifs, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::istringstream ss(line);
    if (ss >> tx >> ty >> tz >> qx >> qy >> qz >> qw) {
      Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
      T.translation() << tx, ty, tz;
      T.linear() = Eigen::Quaterniond(qw, qx, qy, qz).toRotationMatrix();
      return T;
    }
  }
  throw std::runtime_error("no row in " + p.string());
}

static Eigen::Isometry3d interp_pose(const Trajectory& tr, double t) {
  if (t <= tr.ts.front()) {
    Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
    T.translation() = tr.trans.front();
    T.linear() = tr.quats.front().toRotationMatrix();
    return T;
  }
  if (t >= tr.ts.back()) {
    Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
    T.translation() = tr.trans.back();
    T.linear() = tr.quats.back().toRotationMatrix();
    return T;
  }
  auto it = std::upper_bound(tr.ts.begin(), tr.ts.end(), t);
  size_t i1 = it - tr.ts.begin();
  size_t i0 = i1 - 1;
  double a = (t - tr.ts[i0]) / (tr.ts[i1] - tr.ts[i0]);
  Eigen::Vector3d p = (1.0 - a) * tr.trans[i0] + a * tr.trans[i1];
  Eigen::Quaterniond q = tr.quats[i0].slerp(a, tr.quats[i1]);
  Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
  T.translation() = p;
  T.linear() = q.toRotationMatrix();
  return T;
}

static std::vector<PanoFrame> load_panos(const fs::path& pano_dir) {
  std::vector<PanoFrame> out;
  const fs::path poses = pano_dir / "prior_poses.txt";
  const fs::path frames_dir = pano_dir / "frames";
  if (!fs::is_regular_file(poses)) throw std::runtime_error("missing: " + poses.string());
  if (!fs::is_directory(frames_dir)) throw std::runtime_error("missing: " + frames_dir.string());

  std::ifstream ifs(poses);
  std::string line;
  while (std::getline(ifs, line)) {
    if (line.empty() || line[0] == '#') continue;
    std::istringstream ss(line);
    std::string name;
    double tx,ty,tz,qx,qy,qz,qw;
    if (!(ss >> name >> tx >> ty >> tz >> qx >> qy >> qz >> qw)) continue;
    PanoFrame p;
    p.image_path = (frames_dir / name).string();
    try { p.host_sec = std::stod(fs::path(name).stem().string()) * 1e-9; }
    catch (...) { continue; }
    p.T_world_cam = Eigen::Isometry3d::Identity();
    p.T_world_cam.translation() << tx, ty, tz;
    p.T_world_cam.linear() = Eigen::Quaterniond(qw, qx, qy, qz).toRotationMatrix();
    out.push_back(std::move(p));
  }
  std::sort(out.begin(), out.end(), [](const PanoFrame& a, const PanoFrame& b){ return a.host_sec < b.host_sec; });
  return out;
}

// ───── Equirect projection + bilinear sample (unchanged) ────────────────────

// lat_cutoff_deg: skip points that project to within this many degrees of
// the panorama poles (|lat| > 90 - lat_cutoff_deg). Pole pixels have the
// worst equirect distortion AND coincide with Insta fisheye stitching seams,
// giving unreliable colour. 20° cutoff keeps points within ±70° of equator.
// Equirect projection with two optional masks:
//   lat_cutoff_deg: skip |lat| > (90 − cutoff). Used for Insta fisheye
//                   stitching seam only (default small = 10°).
//   mid360_dir:    unit direction (camera frame) toward the Mid360 LiDAR body.
//                  If set, reject points whose bearing is within
//                  mid360_cone_deg of this direction (Mid360 self-occludes
//                  the Insta panorama in that cone).
static inline bool project_equirect(const Eigen::Vector3d& p_cam, int W, int H,
                                    float& u, float& v,
                                    double lat_cutoff_deg = 10.0,
                                    const Eigen::Vector3d* mid360_dir = nullptr,
                                    double mid360_cone_cos = 1.0) {
  const double n = p_cam.norm();
  if (n < 1e-6) return false;
  const Eigen::Vector3d b = p_cam / n;
  if (mid360_dir && b.dot(*mid360_dir) > mid360_cone_cos) return false;   // in Mid360 self-occlusion cone
  const double lat = -std::asin(b.y());
  const double lon = std::atan2(b.x(), b.z());
  const double lat_max = (M_PI / 2.0) - lat_cutoff_deg * M_PI / 180.0;
  if (std::abs(lat) > lat_max) return false;
  u = static_cast<float>(W * (0.5 + lon / (2.0 * M_PI)));
  v = static_cast<float>(H * (0.5 - lat / M_PI));
  if (v < 0 || v > H - 1) return false;
  if (u < 0) u += W;
  if (u >= W) u -= W;
  return true;
}

static inline void bilinear_bgr(const cv::Mat& img, float u, float v,
                                uint8_t& r, uint8_t& g, uint8_t& b_out) {
  const int W = img.cols, H = img.rows;
  int u0 = static_cast<int>(std::floor(u));
  int v0 = static_cast<int>(std::floor(v));
  float du = u - u0;
  float dv = v - v0;
  int u1 = (u0 + 1) % W;
  int v1 = std::min(v0 + 1, H - 1);
  u0 = (u0 + W) % W;
  v0 = std::clamp(v0, 0, H - 1);
  const cv::Vec3b& p00 = img.at<cv::Vec3b>(v0, u0);
  const cv::Vec3b& p01 = img.at<cv::Vec3b>(v0, u1);
  const cv::Vec3b& p10 = img.at<cv::Vec3b>(v1, u0);
  const cv::Vec3b& p11 = img.at<cv::Vec3b>(v1, u1);
  for (int c = 0; c < 3; c++) {
    float v_top = (1 - du) * p00[c] + du * p01[c];
    float v_bot = (1 - du) * p10[c] + du * p11[c];
    float val   = (1 - dv) * v_top + dv * v_bot;
    uint8_t vv = static_cast<uint8_t>(std::clamp(val, 0.0f, 255.0f));
    if (c == 0) b_out = vv;
    else if (c == 1) g = vv;
    else r = vv;
  }
}

// ───── Main ─────────────────────────────────────────────────────────────────

int main(int argc, char** argv) {
  if (argc < 4) {
    std::cerr << "usage: " << argv[0]
              << " <map_dir> <pano_dir> <output.ply> [voxel=0.02] [max_depth=30] [lat_cutoff=30]\n";
    return 1;
  }
  const fs::path map_dir  = argv[1];
  const fs::path pano_dir = argv[2];
  const fs::path out_path = argv[3];
  const double voxel      = (argc >= 5) ? std::stod(argv[4]) : 0.02;
  const double max_depth  = (argc >= 6) ? std::stod(argv[5]) : 30.0;
  const double lat_cutoff      = (argc >= 7) ? std::stod(argv[6]) : 10.0;
  const double mid360_cone_deg = (argc >= 8) ? std::stod(argv[7]) : 20.0;   // smaller cone — only block Mid360 body, not neighboring ground
  const double min_depth       = 0.3;
  const int    K_PANO          = 12;   // fallback depth for Mid360 cone miss
  std::cout << "[cfg] voxel=" << voxel << "m  max_depth=" << max_depth
            << "m  lat_cutoff=" << lat_cutoff << "°  mid360_cone=" << mid360_cone_deg << "°\n";

  // Load inputs
  Trajectory tr = load_traj(map_dir / "traj_lidar.txt");
  Eigen::Isometry3d T_imu_lidar = load_t_imu_lidar(map_dir / "raw_frames" / "t_imu_lidar.txt");
  std::vector<PanoFrame> panos = load_panos(pano_dir);
  std::cout << "[traj] " << tr.ts.size() << " poses, [" << tr.ts.front() << ", " << tr.ts.back() << "]\n";
  std::cout << "[pano] " << panos.size() << " panoramas\n";
  if (panos.empty()) { std::cerr << "no panorama frames\n"; return 2; }

  std::vector<fs::path> bins;
  for (auto& e : fs::directory_iterator(map_dir / "raw_frames")) {
    if (e.path().extension() == ".bin") bins.push_back(e.path());
  }
  std::sort(bins.begin(), bins.end());
  std::cout << "[frames] " << bins.size() << " scan files\n";

  // Derive Mid360-in-camera direction from the first pano + traj_lidar.
  // T_lidar_camera is physically constant (rigid helmet mount); any (pano, traj)
  // pair gives the same answer. Mid360 origin in camera frame = T_cam_lidar.translation().
  Eigen::Vector3d mid360_dir;
  double mid360_cone_cos = std::cos(mid360_cone_deg * M_PI / 180.0);
  {
    const auto& p0 = panos[0];
    const Eigen::Isometry3d T_wl_at_p0 = interp_pose(tr, p0.host_sec);
    const Eigen::Isometry3d T_lidar_cam = T_wl_at_p0.inverse() * p0.T_world_cam;
    const Eigen::Vector3d mid_in_cam = T_lidar_cam.inverse().translation();  // LIDAR origin in cam frame
    const double n = mid_in_cam.norm();
    if (n < 1e-6) {
      std::cout << "[warn] camera-lidar distance ~0, Mid360 cone mask disabled\n";
      mid360_cone_cos = 1.0;    // disables mask
      mid360_dir = Eigen::Vector3d::UnitZ();
    } else {
      mid360_dir = mid_in_cam / n;
      std::cout << "[cfg] Mid360 direction in cam frame = ["
                << mid360_dir.transpose() << "]  distance=" << n << "m\n";
    }
  }
  const Eigen::Vector3d* mid360_dir_p = (mid360_cone_cos < 1.0) ? &mid360_dir : nullptr;

  // ─── Round 1: build world-frame geometry cloud ──────────────────────────
  std::cout << "\n[round 1] aggregate + deskew geometry...\n";
  pcl::PointCloud<pcl::PointXYZ>::Ptr accum(new pcl::PointCloud<pcl::PointXYZ>);
  glim::CloudDeskewing deskewer;
  size_t total_raw = 0, kept_scans = 0, skipped = 0;

  for (const auto& b : bins) {
    ScanData s;
    if (!read_scan(b, s)) { skipped++; continue; }
    if (s.base_stamp < tr.ts.front() - 0.1 || s.base_stamp > tr.ts.back() + 0.1) { skipped++; continue; }

    std::vector<Eigen::Vector4d> desk = s.imu_times.empty()
      ? deskewer.deskew(T_imu_lidar, Eigen::Vector3d::Zero(), Eigen::Vector3d::Zero(),
                        s.rel_times, s.points)
      : deskewer.deskew(T_imu_lidar, s.imu_times, s.imu_poses,
                        s.base_stamp, s.rel_times, s.points);
    const Eigen::Isometry3d T_wl = interp_pose(tr, s.base_stamp);

    accum->points.reserve(accum->points.size() + desk.size());
    for (const auto& pd : desk) {
      Eigen::Vector3d pw = (T_wl * pd).head<3>();
      accum->points.emplace_back(pw.x(), pw.y(), pw.z());
    }
    total_raw += desk.size();
    kept_scans++;
  }
  accum->width = accum->points.size();
  accum->height = 1;
  accum->is_dense = false;
  std::cout << "[round 1] " << total_raw << " raw points, " << kept_scans
            << " scans (skipped " << skipped << ")\n";

  // Voxel downsample
  pcl::PointCloud<pcl::PointXYZ>::Ptr ds(new pcl::PointCloud<pcl::PointXYZ>);
  if (voxel > 0.0) {
    pcl::VoxelGrid<pcl::PointXYZ> vg;
    vg.setInputCloud(accum);
    vg.setLeafSize(voxel, voxel, voxel);
    vg.filter(*ds);
    std::cout << "[voxel " << voxel << "] " << accum->size() << " → " << ds->size() << "\n";
  } else {
    ds = accum;
  }
  accum.reset();

  // ─── Round 2: per-point colouring from spatially-nearest pano ───────────
  std::cout << "\n[round 2] colour each point via nearest-camera pano...\n";

  // Build KdTree on panorama camera centres (world frame).
  pcl::PointCloud<pcl::PointXYZ>::Ptr cam_centres(new pcl::PointCloud<pcl::PointXYZ>);
  cam_centres->points.reserve(panos.size());
  for (const auto& p : panos) {
    cam_centres->points.emplace_back(p.T_world_cam.translation().x(),
                                     p.T_world_cam.translation().y(),
                                     p.T_world_cam.translation().z());
  }
  cam_centres->width = cam_centres->points.size();
  cam_centres->height = 1;
  pcl::KdTreeFLANN<pcl::PointXYZ> kd;
  kd.setInputCloud(cam_centres);

  // Step 2a: SPATIAL CONSISTENCY — bin points into coarse grid, assign one
  // candidate pano list PER BIN (not per point). All points in a 10cm cell get
  // the same ranked pano candidates. This prevents picture frames / tags from
  // being coloured by many different panoramas (each with slightly offset
  // projections) and tearing apart at the edges.
  const double BIN_SIZE = 0.05;      // 5cm spatial consistency window — smaller = less lost geometry at bin boundary
  const double W_DIST = 2.0;         // weight distance more now (equator preference weakened)
  const double W_LAT  = 1.0;         // weak lat preference — Mid360 cone handles LiDAR body already
  std::cout << "  [2a] binning " << ds->size() << " points into " << BIN_SIZE << "m cells...\n";

  // bin_key: (ix,iy,iz) → bin_id; bin_centers / bin_pts_idx keep per-bin data.
  struct BinKey { int ix, iy, iz; bool operator==(const BinKey& o) const { return ix==o.ix && iy==o.iy && iz==o.iz; } };
  struct BinKeyHash { size_t operator()(const BinKey& k) const {
    return (size_t)k.ix * 73856093u ^ (size_t)k.iy * 19349663u ^ (size_t)k.iz * 83492791u;
  } };
  std::unordered_map<BinKey, int, BinKeyHash> bin_map;
  std::vector<Eigen::Vector3d> bin_centers;    // one centroid per bin
  std::vector<int> point_bin(ds->size(), -1);
  for (size_t i = 0; i < ds->size(); i++) {
    const auto& p = ds->points[i];
    BinKey k{ (int)std::floor(p.x / BIN_SIZE), (int)std::floor(p.y / BIN_SIZE), (int)std::floor(p.z / BIN_SIZE) };
    auto it = bin_map.find(k);
    int bid;
    if (it == bin_map.end()) {
      bid = bin_centers.size();
      bin_map[k] = bid;
      bin_centers.emplace_back(p.x, p.y, p.z);
    } else {
      bid = it->second;
      // running average
      Eigen::Vector3d& c = bin_centers[bid];
      c += (Eigen::Vector3d(p.x, p.y, p.z) - c) * 0.5;
    }
    point_bin[i] = bid;
  }
  std::cout << "  [2a] " << bin_centers.size() << " bins, "
            << (double)ds->size() / bin_centers.size() << " avg pts/bin\n";

  // Rank panos per bin centroid.
  std::vector<std::vector<int>> bin_knn_idx(bin_centers.size());
  std::vector<int> knn_idx(K_PANO);
  std::vector<float> knn_d2(K_PANO);
  for (size_t b = 0; b < bin_centers.size(); b++) {
    pcl::PointXYZ q(bin_centers[b].x(), bin_centers[b].y(), bin_centers[b].z());
    int n = kd.nearestKSearch(q, K_PANO, knn_idx, knn_d2);
    std::vector<std::pair<double,int>> scored;
    scored.reserve(n);
    for (int k = 0; k < n; k++) {
      const int pi = knn_idx[k];
      const Eigen::Vector3d p_cam = panos[pi].T_world_cam.inverse() * bin_centers[b];
      const double norm = p_cam.norm();
      if (norm < 1e-6) continue;
      const double lat_abs = std::abs(std::asin(-p_cam.y() / norm));
      const double lat_quality = 1.0 - lat_abs / (M_PI / 2.0);
      const double score = W_DIST / (std::sqrt(knn_d2[k]) + 0.1) + W_LAT * lat_quality;
      scored.emplace_back(score, pi);
    }
    std::sort(scored.begin(), scored.end(), [](const auto& a, const auto& b){ return a.first > b.first; });
    bin_knn_idx[b].reserve(scored.size());
    for (const auto& s : scored) bin_knn_idx[b].push_back(s.second);
  }

  // Project per-point rank from bin rank. Points in same bin share rank list.
  std::vector<std::vector<int>> point_knn_idx(ds->size());
  for (size_t i = 0; i < ds->size(); i++) {
    point_knn_idx[i] = bin_knn_idx[point_bin[i]];
  }

  // Step 2b: process pano-by-pano. For each point, try its K ranked candidates
  // in order (best score first) until one passes depth + lat gate. One image
  // load per pano per attempt pass.
  std::unordered_map<int, std::vector<size_t>> pano_to_points;
  pcl::PointCloud<pcl::PointXYZRGB>::Ptr colored(new pcl::PointCloud<pcl::PointXYZRGB>);
  colored->points.resize(ds->size());
  std::vector<uint8_t> point_colored(ds->size(), 0);
  size_t colored_ok = 0;

  for (int attempt = 0; attempt < K_PANO; attempt++) {
    // Rebuild grouping for this attempt.
    pano_to_points.clear();
    for (size_t i = 0; i < ds->size(); i++) {
      if (!point_colored[i] && attempt < (int)point_knn_idx[i].size()) {
        pano_to_points[point_knn_idx[i][attempt]].push_back(i);
      }
    }
    if (pano_to_points.empty()) break;
    std::cout << "  [2c] attempt " << attempt << ": " << pano_to_points.size()
              << " panos, " << std::accumulate(pano_to_points.begin(), pano_to_points.end(), size_t(0),
                                               [](size_t s, const auto& kv){ return s + kv.second.size(); })
              << " pending points\n";

    size_t pano_i = 0;
    for (auto& [pi, pts_idx] : pano_to_points) {
      cv::Mat img = cv::imread(panos[pi].image_path, cv::IMREAD_COLOR);
      if (img.empty()) continue;
      const int W = img.cols, H = img.rows;
      const Eigen::Isometry3d T_cw = panos[pi].T_world_cam.inverse();

      for (size_t idx : pts_idx) {
        const auto& p = ds->points[idx];
        const Eigen::Vector3d p_cam = T_cw * Eigen::Vector3d(p.x, p.y, p.z);
        const double depth = p_cam.norm();
        if (depth < min_depth || depth > max_depth) continue;
        float u, v;
        if (!project_equirect(p_cam, W, H, u, v, lat_cutoff, mid360_dir_p, mid360_cone_cos)) continue;
        uint8_t r, g, bb;
        bilinear_bgr(img, u, v, r, g, bb);
        pcl::PointXYZRGB cp;
        cp.x = p.x; cp.y = p.y; cp.z = p.z;
        cp.r = r; cp.g = g; cp.b = bb;
        colored->points[idx] = cp;
        point_colored[idx] = 1;
        colored_ok++;
      }
      pano_i++;
      if (pano_i % 50 == 0) {
        std::cout << "    [attempt " << attempt << "] processed " << pano_i << "/" << pano_to_points.size() << " panos\n";
      }
    }
  }

  // Compact: drop uncoloured points.
  pcl::PointCloud<pcl::PointXYZRGB>::Ptr compact(new pcl::PointCloud<pcl::PointXYZRGB>);
  compact->points.reserve(colored_ok);
  for (size_t i = 0; i < ds->size(); i++) {
    if (point_colored[i]) compact->points.push_back(colored->points[i]);
  }
  colored = compact;
  size_t no_pano = ds->size() - colored_ok;
  colored->width = colored->points.size();
  colored->height = 1;
  colored->is_dense = false;
  std::cout << "[round 2] " << colored_ok << " coloured / " << ds->size()
            << " voxel points (" << no_pano << " no suitable pano)\n";

  fs::create_directories(out_path.parent_path());
  pcl::io::savePLYFileBinary(out_path.string(), *colored);
  std::cout << "[done] " << out_path << " (" << colored->size() << " RGB points)\n";
  return 0;
}
