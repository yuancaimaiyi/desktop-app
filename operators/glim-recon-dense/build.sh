#!/bin/bash
# Build the glim-recon self-describing wrapper image and verify --describe output.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE="hera-glim-recon:r0.5"

echo "=== Building $IMAGE ==="
docker build \
    -f "$SCRIPT_DIR/Dockerfile.describe" \
    -t "$IMAGE" \
    "$SCRIPT_DIR"

echo ""
echo "=== docker run --rm $IMAGE --describe ==="
docker run --rm "$IMAGE" --describe | python3 -m json.tool
