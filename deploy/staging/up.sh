#!/usr/bin/env bash
# Build the test-machine image and (re)start the simulator on this host.
# Run from anywhere: deploy/staging/up.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

docker build -t contabo-sim-ubuntu:22.04 "$root/docker/ubuntu-systemd"
docker compose -f "$here/docker-compose.yml" up -d --build

for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:8099/dashboard; then
    echo "simulator up on http://127.0.0.1:8099"
    exit 0
  fi
  sleep 1
done
echo "simulator did not answer on 127.0.0.1:8099; check: docker compose -f $here/docker-compose.yml logs" >&2
exit 1
