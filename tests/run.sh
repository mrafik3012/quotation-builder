#!/usr/bin/env bash
# Runs the whole test suite against a throw-away install (no setup beyond php + node).
#   tests/run.sh            -> parity, API, MCP, OAuth, accounts, billing, features, cron, scale   (SQLite, no browser)
#   tests/run.sh --e2e      -> + Playwright browser tests (XSS, mobile, PDF, 2FA UI, accessibility)
# MySQL:   MYSQL_DB=qb_test MYSQL_USER=qb MYSQL_PASS=secret tests/run.sh      (database must exist and be empty)
# Apache:  tests/apache.test.js self-skips on PHP's built-in server; run it with BASE=http://your-apache-host node tests/apache.test.js
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8799}"
WORK="$(mktemp -d)"
trap 'kill $PHP_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT

install_app() {   # fresh install into $WORK (wipes the previous database)
  rm -f "$WORK"/api/config.php "$WORK"/api/data/*.sqlite 2>/dev/null || true
  if [ -n "${MYSQL_DB:-}" ]; then
    mysql ${MYSQL_HOST:+-h "$MYSQL_HOST"} ${MYSQL_ROOT_USER:+-u "$MYSQL_ROOT_USER"} ${MYSQL_ROOT_PASS:+-p"$MYSQL_ROOT_PASS"} -e "DROP DATABASE IF EXISTS $MYSQL_DB; CREATE DATABASE $MYSQL_DB CHARACTER SET utf8mb4;" 2>/dev/null || true
    php install.php --host="${MYSQL_HOST:-localhost}" --dbname="$MYSQL_DB" --dbuser="$MYSQL_USER" --dbpass="${MYSQL_PASS:-}" --email=a@b.com --password=changeme123 >/dev/null
  else
    php install.php --sqlite --email=a@b.com --password=changeme123 >/dev/null
  fi
}
start_server() {
  [ -n "${PHP_PID:-}" ] && kill "$PHP_PID" 2>/dev/null && sleep 0.5 || true
  php -S "127.0.0.1:$PORT" tests/router.php >"$WORK/server.log" 2>&1 &
  PHP_PID=$!
  sleep 1
}

cp -r "$ROOT/." "$WORK/" && rm -rf "$WORK/.git"
cd "$WORK"
export BASE="http://127.0.0.1:$PORT" APP_DIR="$WORK"

echo "== money math parity (browser JS vs server PHP)";        node tests/parity.js
echo "== roof calculator parity (browser JS vs server PHP)";   node tests/roof_parity.js

# suites that share rate limits / counters each get a fresh database
for suite in api mcp oauth accounts billing features cron automation scale; do
  install_app; start_server
  echo "== $suite"; node "tests/$suite.test.js"
done

if [ "${1:-}" = "--e2e" ]; then
  install_app; start_server
  echo "== browser e2e (XSS, mobile, PDF, 2FA UI, pagination, accessibility)"; node tests/e2e.js
fi
echo "ALL TESTS PASSED"
