// build_dense_cloud: construct a dense world-frame coloured point cloud
// from GLIM plugin dumps + loop-closed traj_lidar.txt.
//
// For each per-scan .bin produced by libglim_dense_dump.so we:
//   1. Deskew points at IMU-rate fidelity using GLIM's own CloudDeskewing
//      with the per-frame IMU-rate trajectory embedded in the .bin.
//      Output of deskew is in SCAN-START LIDAR frame.
//   2. Multiply by T_world_lidar(base_stamp) interpolated from traj_lidar.txt
//      (loop-closed) to go to world.
//   3. Concatenate with intensity.
// Finally run PCL VoxelGrid downsample + write PCD/PLY.
//
// Usage:
//   build_dense_cloud <map_dir> <output.ply|.pcd> [voxel=0.02]

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

#include <Eigen/Dense>
#include <Eigen/Geometry>

#include <glim/common/cloud_deskewing.hpp>

#include <pcl/point_cloud.h>
#include <pcl/point_types.h>
#include <pcl/filters/voxel_grid.h>
#include <pcl/io/pcd_io.h>
#include <pcl/io/ply_io.h>

namespace fs = std::filesystem;

struct ScanData {
  double base_stamp = 0.0;
  std::vector<Eigen::Vector4d> points;          // homogeneous for GLIM API
  std::vector<double> rel_times;
  std::vector<float>  intensities;
  bool has_intensity = false;

  // Per-frame IMU-rate trajectory (same as EstimationFrame::imu_rate_trajectory).
  std::vector<double> imu_times;                // absolute times
  std::vector<Eigen::Isometry3d> imu_poses;     // T_world_imu
};

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
    ifs.read(reinterpret_cast<char*>(&tx), 4);
    ifs.read(reinterpret_cast<char*>(&ty), 4);
    ifs.read(reinterpret_cast<char*>(&tz), 4);
    ifs.read(reinterpret_cast<char*>(&qx), 4);
    ifs.read(reinterpret_cast<char*>(&qy), 4);
    ifs.read(reinterpret_cast<char*>(&qz), 4);
    ifs.read(reinterpret_cast<char*>(&qw), 4);
    out.imu_times[i] = t;
    Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
    T.translation() << tx, ty, tz;
    T.linear() = Eigen::Quaterniond(qw, qx, qy, qz).toRotationMatrix();
    out.imu_poses[i] = T;
  }

  return true;
}

// (ts, trans, quats_xyzw) — sorted by ts ascending.
struct Trajectory {
  std::vector<double> ts;
  std::vector<Eigen::Vector3d> trans;
  std::vector<Eigen::Quaterniond> quats;  // (w,x,y,z) order inside Eigen
};

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
  // sort
  std::vector<size_t> idx(tr.ts.size());
  std::iota(idx.begin(), idx.end(), 0);
  std::sort(idx.begin(), idx.end(), [&](size_t a, size_t b) { return tr.ts[a] < tr.ts[b]; });
  Trajectory sorted;
  sorted.ts.reserve(tr.ts.size()); sorted.trans.reserve(tr.ts.size()); sorted.quats.reserve(tr.ts.size());
  for (auto i : idx) { sorted.ts.push_back(tr.ts[i]); sorted.trans.push_back(tr.trans[i]); sorted.quats.push_back(tr.quats[i]); }
  return sorted;
}

// linear t + SLERP r interp of per-frame T_world_lidar at absolute `t`.
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
  double t0 = tr.ts[i0], t1 = tr.ts[i1];
  double a = (t - t0) / (t1 - t0);
  Eigen::Vector3d p = (1.0 - a) * tr.trans[i0] + a * tr.trans[i1];
  Eigen::Quaterniond q = tr.quats[i0].slerp(a, tr.quats[i1]);
  Eigen::Isometry3d T = Eigen::Isometry3d::Identity();
  T.translation() = p;
  T.linear() = q.toRotationMatrix();
  return T;
}

static Eigen::Isometry3d load_t_imu_lidar(const fs::path& p) {
  std::ifstream ifs(p);
  if (!ifs) throw std::runtime_error("cannot open " + p.string());
  std::string line;
  double tx, ty, tz, qx, qy, qz, qw;
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

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cerr << "usage: " << argv[0] << " <map_dir> <output.ply|.pcd> [voxel=0.02]\n";
    return 1;
  }
  const fs::path map_dir = argv[1];
  const fs::path out_path = argv[2];
  const double voxel = (argc >= 4) ? std::stod(argv[3]) : 0.02;

  const fs::path traj_path = map_dir / "traj_lidar.txt";
  const fs::path frames_dir = map_dir / "raw_frames";
  const fs::path til_path = frames_dir / "t_imu_lidar.txt";

  if (!fs::is_regular_file(traj_path)) { std::cerr << "missing: " << traj_path << "\n"; return 2; }
  if (!fs::is_directory(frames_dir))   { std::cerr << "missing: " << frames_dir << "\n"; return 2; }
  if (!fs::is_regular_file(til_path))  { std::cerr << "missing: " << til_path << " — plugin older than v0.2?\n"; return 2; }

  Trajectory tr = load_traj(traj_path);
  std::cout << "[traj] " << tr.ts.size() << " poses, ["
            << tr.ts.front() << ", " << tr.ts.back() << "]\n";

  Eigen::Isometry3d T_imu_lidar = load_t_imu_lidar(til_path);
  std::cout << "[extr] T_imu_lidar  trans=[" << T_imu_lidar.translation().transpose() << "]\n";

  std::vector<fs::path> bins;
  for (auto& e : fs::directory_iterator(frames_dir)) {
    if (e.path().extension() == ".bin") bins.push_back(e.path());
  }
  std::sort(bins.begin(), bins.end());
  std::cout << "[frames] " << bins.size() << " scan files\n";

  pcl::PointCloud<pcl::PointXYZI>::Ptr accum(new pcl::PointCloud<pcl::PointXYZI>);
  accum->reserve(bins.size() * 10000);

  glim::CloudDeskewing deskewer;
  size_t total_raw = 0, kept = 0, skipped = 0;

  for (const auto& b : bins) {
    ScanData s;
    if (!read_scan(b, s)) { skipped++; continue; }
    if (s.base_stamp < tr.ts.front() - 0.1 || s.base_stamp > tr.ts.back() + 0.1) { skipped++; continue; }

    // Deskew to scan-start LIDAR frame.
    std::vector<Eigen::Vector4d> desk;
    if (!s.imu_times.empty()) {
      desk = deskewer.deskew(T_imu_lidar, s.imu_times, s.imu_poses,
                             s.base_stamp, s.rel_times, s.points);
    } else {
      // No IMU-rate traj — fall back to no-motion deskew (zero vel).
      desk = deskewer.deskew(T_imu_lidar, Eigen::Vector3d::Zero(), Eigen::Vector3d::Zero(),
                             s.rel_times, s.points);
    }

    // Loop-closed world pose at scan start.
    Eigen::Isometry3d T_wl = interp_pose(tr, s.base_stamp);

    const size_t n = desk.size();
    accum->points.reserve(accum->points.size() + n);
    for (size_t i = 0; i < n; i++) {
      Eigen::Vector3d pw = (T_wl * desk[i]).head<3>();
      pcl::PointXYZI pt;
      pt.x = static_cast<float>(pw.x());
      pt.y = static_cast<float>(pw.y());
      pt.z = static_cast<float>(pw.z());
      pt.intensity = s.has_intensity ? s.intensities[i] : 0.0f;
      accum->points.push_back(pt);
    }
    total_raw += n;
    kept++;
  }
  accum->width = static_cast<uint32_t>(accum->points.size());
  accum->height = 1;
  accum->is_dense = false;
  std::cout << "[concat] " << total_raw << " points from " << kept
            << " frames (skipped " << skipped << ")\n";

  pcl::PointCloud<pcl::PointXYZI>::Ptr ds(new pcl::PointCloud<pcl::PointXYZI>);
  if (voxel > 0.0) {
    pcl::VoxelGrid<pcl::PointXYZI> vg;
    vg.setInputCloud(accum);
    vg.setLeafSize(voxel, voxel, voxel);
    vg.filter(*ds);
    std::cout << "[voxel " << voxel << "] " << accum->size() << " → " << ds->size() << "\n";
  } else {
    ds = accum;
  }

  fs::create_directories(out_path.parent_path());
  std::string ext = out_path.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c){ return std::tolower(c); });
  if (ext == ".pcd") {
    pcl::io::savePCDFileBinary(out_path.string(), *ds);
  } else {
    pcl::io::savePLYFileBinary(out_path.string(), *ds);
  }
  std::cout << "[done] wrote " << out_path << " (" << ds->size() << " points)\n";
  return 0;
}
