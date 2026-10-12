#!/bin/sh
# colorize_entry: locate the latest glim dense recon map/ AND the <stem>_pano/
# dir inside the session directory, then call the binary.
#
# Conventions (produced by the preceding workflows the user already ran):
#   session_dir/<ts>-reconstruct_pointcloud_dense/step_recon/map/     ← GLIM
#   session_dir/<stem>_pano/{frames/, prior_poses.txt}                ← panorama_to_prior_poses.py
set -e

SESSION_DIR="$1"
OUT_PLY="$2"
VOXEL="$3"
MAX_DEPTH="$4"
LAT_CUT="$5"

# --- Locate the newest dense reconstruction map/ under session_dir ---
MAP_DIR=""
# find the newest sibling dir matching *-reconstruct_pointcloud_dense that has
# step_recon/map/traj_lidar.txt
for d in $(ls -1dt "$SESSION_DIR"/*-reconstruct_pointcloud_dense 2>/dev/null); do
    if [ -f "$d/step_recon/map/traj_lidar.txt" ] && [ -d "$d/step_recon/map/raw_frames" ]; then
        MAP_DIR="$d/step_recon/map"
        break
    fi
done
if [ -z "$MAP_DIR" ]; then
    echo "[error] no reconstruct_pointcloud_dense output found under $SESSION_DIR"
    echo "[error] run \"激光重建出点云 (稠密)\" workflow first on this .hera"
    echo "[error] contents of $SESSION_DIR:"
    ls -la "$SESSION_DIR" | head -40
    exit 2
fi

# --- Locate <stem>_pano/ sibling dir ---
PANO_DIR=""
for d in "$SESSION_DIR"/*_pano "$SESSION_DIR"/*_pano_*; do
    if [ -d "$d" ] && [ -f "$d/prior_poses.txt" ] && [ -d "$d/frames" ]; then
        PANO_DIR="$d"
        break
    fi
done
# fallback: any sibling with prior_poses.txt + frames/
if [ -z "$PANO_DIR" ]; then
    for d in "$SESSION_DIR"/*; do
        if [ -d "$d" ] && [ -f "$d/prior_poses.txt" ] && [ -d "$d/frames" ]; then
            PANO_DIR="$d"
            break
        fi
    done
fi
if [ -z "$PANO_DIR" ]; then
    echo "[error] no sibling panorama directory found under $SESSION_DIR"
    echo "[error] expected <stem>_pano/ with prior_poses.txt and frames/"
    echo "[error] produced by panorama_to_prior_poses.py --out_dir <stem>_pano"
    echo "[error] contents of $SESSION_DIR:"
    ls -la "$SESSION_DIR" | head -40
    exit 2
fi

echo "[info] using map dir : $MAP_DIR"
echo "[info] using pano dir: $PANO_DIR"
exec /opt/scripts/panorama_colorize "$MAP_DIR" "$PANO_DIR" "$OUT_PLY" "$VOXEL" "$MAX_DEPTH" "$LAT_CUT"
