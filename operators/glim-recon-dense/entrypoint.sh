#!/bin/sh
# Hera entrypoint wrapper: intercepts --describe, else sources ROS env and exec's the command.
set -e
if [ "$1" = "--describe" ]; then
    cat /operator.json
    exit 0
fi
# Source ROS 2 environment (works for Humble/Iron/Jazzy layouts)
for _setup in /opt/ros/*/setup.sh; do
    [ -f "$_setup" ] && . "$_setup" && break
done
exec "$@"
