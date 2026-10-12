#!/bin/sh
# Build the glim-dense-cloud operator image locally.
set -e
cd "$(dirname "$0")"
IMAGE="crpi-wzvoh0tsm7bwb22w.cn-shanghai.personal.cr.aliyuncs.com/glim/glim-dense-cloud:0.2"
docker build -t "$IMAGE" .
echo "Built $IMAGE"
