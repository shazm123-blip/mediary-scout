#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

case "${1:-up}" in
  up)
    GIT_SHA="$(git rev-parse HEAD)"
    export GIT_SHA
    docker compose -f docker-compose.local.yml up -d --build --wait
    printf '本地测试地址：http://127.0.0.1:%s\n' "${LOCAL_WEB_PORT:-13080}"
    ;;
  down)
    # Keep the database volume for the next development session.
    docker compose -f docker-compose.local.yml down
    ;;
  logs)
    docker compose -f docker-compose.local.yml logs --tail=100 web
    ;;
  *)
    printf '用法：%s [up|down|logs]\n' "$0" >&2
    exit 2
    ;;
esac
