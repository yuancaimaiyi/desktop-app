#!/bin/sh
set -e
if [ "$1" = "--describe" ]; then
    cat /operator.json
    exit 0
fi
exec "$@"
