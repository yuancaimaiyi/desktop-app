#!/bin/sh
set -e
cd "$(dirname "$0")"
IMAGE="crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/panorama-colorize:0.1"
docker build -t "$IMAGE" .
echo "Built $IMAGE"
