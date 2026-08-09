#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
script="$root/deploy/deploy-host.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git init --bare "$tmp/gitee.git" >/dev/null
git clone "$tmp/gitee.git" "$tmp/source" >/dev/null 2>&1
git -C "$tmp/source" config user.email test@example.invalid
git -C "$tmp/source" config user.name test
printf 'one\n' >"$tmp/source/README.md"
git -C "$tmp/source" add README.md && git -C "$tmp/source" commit -m one >/dev/null
sha1="$(git -C "$tmp/source" rev-parse HEAD)"
git -C "$tmp/source" push origin HEAD:main >/dev/null
mkdir -p "$tmp/source/apps/api" "$tmp/source/apps/web"
printf '{}\n' >"$tmp/source/package.json"
git -C "$tmp/source" add . && git -C "$tmp/source" commit -m two >/dev/null
sha2="$(git -C "$tmp/source" rev-parse HEAD)"
git -C "$tmp/source" push origin HEAD:main >/dev/null

mkdir -p "$tmp/bin"
cat >"$tmp/bin/bun" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1" == install ]]; then mkdir -p node_modules; exit 0; fi
if [[ "$1" == run && "$2" == build:web ]]; then mkdir -p apps/web/.output/public apps/web/.output/server; : >apps/web/.output/server/index.mjs; exit 0; fi
if [[ "$1" == run && "$2" == build:api ]]; then mkdir -p apps/api/dist; : >apps/api/dist/index.js; exit 0; fi
EOF
cat >"$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
EOF
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$tmp/bin/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$tmp/bin"/*

envs=(DEPLOY_ROOT="$tmp/host" REPO_DIR="$tmp/host/repo" RELEASES_DIR="$tmp/host/releases"
  DEPLOY_STATE_DIR="$tmp/host/deploy" CURRENT_LINK="$tmp/host/current"
  CURRENT_MARKER="$tmp/host/deploy/current-sha" PREVIOUS_MARKER="$tmp/host/deploy/previous-sha"
  LOCK_FILE="$tmp/host/deploy.lock" GITEE_REMOTE="$tmp/gitee.git" BUN_BIN="$tmp/bin/bun"
  SYSTEMCTL_BIN="$tmp/bin/systemctl" CURL_BIN="$tmp/bin/curl" FLOCK_BIN="$tmp/bin/flock" DEPLOY_TEST_MODE=1 HEALTH_RETRIES=1
  SYSTEMCTL_LOG="$tmp/systemctl.log")

env "${envs[@]}" bash "$script" "$sha1"
test "$(cat "$tmp/host/deploy/current-sha")" = "$sha1"
test -e "$tmp/host/releases/$sha1"
env "${envs[@]}" bash "$script" "$sha2"
test "$(cat "$tmp/host/deploy/current-sha")" = "$sha2"
test "$(cat "$tmp/host/deploy/previous-sha")" = "$sha1"
test -e "$tmp/host/releases/$sha1"

printf 'three\n' >"$tmp/source/apps/web/changed.txt"
git -C "$tmp/source" add . && git -C "$tmp/source" commit -m three >/dev/null
sha3="$(git -C "$tmp/source" rev-parse HEAD)"
git -C "$tmp/source" push origin HEAD:main >/dev/null
cat >"$tmp/bin/fail-curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
chmod +x "$tmp/bin/fail-curl"
if env "${envs[@]}" CURL_BIN="$tmp/bin/fail-curl" bash "$script" "$sha3" 2>/dev/null; then
  echo 'failed health gate accepted' >&2
  exit 1
fi
test "$(cat "$tmp/host/deploy/current-sha")" = "$sha2"
test -L "$tmp/host/current"
test -e "$tmp/host/releases/$sha2"
test ! -e "$tmp/host/releases/$sha3"

if env "${envs[@]}" bash "$script" "${sha2%?}x" 2>/dev/null; then
  echo 'invalid SHA accepted' >&2
  exit 1
fi

echo 'deploy-host tests: ok'
