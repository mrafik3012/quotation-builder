#!/usr/bin/env bash
# Runs the whole test suite against a throw-away SQLite install (no setup needed beyond php + node).
#   tests/run.sh            -> API, MCP, parity tests (fast, no browser)
#   tests/run.sh --e2e      -> also the Playwright browser tests (needs: npm i -g playwright)
# MySQL:  MYSQL_DB=qb_test MYSQL_USER=qb MYSQL_PASS=secret tests/run.sh   (database must exist and be empty)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8799}"
WORK="$(mktemp -d)"
trap 'kill $PHP_PID 2>/dev/null || true; rm -rf "$WORK"' EXIT
cp -r "$ROOT/." "$WORK/" && rm -rf "$WORK/.git"
cd "$WORK"
if [ -n "${MYSQL_DB:-}" ]; then
  php install.php --host="${MYSQL_HOST:-localhost}" --dbname="$MYSQL_DB" --dbuser="$MYSQL_USER" --dbpass="${MYSQL_PASS:-}" --email=a@b.com --password=changeme123
else
  php install.php --sqlite --email=a@b.com --password=changeme123
fi
php -S "127.0.0.1:$PORT" >"$WORK/server.log" 2>&1 &
PHP_PID=$!
sleep 1
export BASE="http://127.0.0.1:$PORT"
echo "== money math parity (browser JS vs server PHP)";  node tests/parity.js
echo "== roof calculator parity (browser JS vs server PHP)"; node tests/roof_parity.js
echo "== API & workflow tests";  node tests/api.test.js
echo "== MCP server tests";      node tests/mcp.test.js
if [ "${1:-}" = "--e2e" ]; then
  # the e2e suite needs a fresh database (public rate limits are per IP), so reinstall quickly
  kill $PHP_PID; sleep 0.5; rm -f api/config.php api/data/app.sqlite
  if [ -n "${MYSQL_DB:-}" ]; then mysql -e "DROP DATABASE $MYSQL_DB; CREATE DATABASE $MYSQL_DB CHARACTER SET utf8mb4;" ; php install.php --host="${MYSQL_HOST:-localhost}" --dbname="$MYSQL_DB" --dbuser="$MYSQL_USER" --dbpass="${MYSQL_PASS:-}" --email=a@b.com --password=changeme123
  else php install.php --sqlite --email=a@b.com --password=changeme123; fi
  php -S "127.0.0.1:$PORT" >"$WORK/server.log" 2>&1 & PHP_PID=$!; sleep 1
  echo "== browser e2e (XSS, mobile, permissions, totals)"; node tests/e2e.js
fi
echo "ALL TESTS PASSED"
