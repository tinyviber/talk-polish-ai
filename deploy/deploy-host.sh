#!/usr/bin/env bash
set -Eeuo pipefail

# Host-side source deployment. Host-specific values come from environment.

readonly TARGET_SHA="${1:-}"
readonly DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/kotoba}"
readonly REPO_DIR="${REPO_DIR:-$DEPLOY_ROOT/repo}"
readonly RELEASES_DIR="${RELEASES_DIR:-$DEPLOY_ROOT/releases}"
readonly DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-$DEPLOY_ROOT/deploy}"
readonly CURRENT_LINK="${CURRENT_LINK:-$DEPLOY_ROOT/current}"
readonly CURRENT_MARKER="${CURRENT_MARKER:-$DEPLOY_STATE_DIR/current-sha}"
readonly PREVIOUS_MARKER="${PREVIOUS_MARKER:-$DEPLOY_STATE_DIR/previous-sha}"
readonly LOCK_FILE="${LOCK_FILE:-/run/lock/kotoba-deploy.lock}"
readonly GITEE_REMOTE="${GITEE_REMOTE:-}"
readonly GITEE_REF="${GITEE_REF:-}"
readonly BUN_BIN="${BUN_BIN:-bun}"
readonly SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
readonly FLOCK_BIN="${FLOCK_BIN:-flock}"
readonly CURL_BIN="${CURL_BIN:-curl}"
readonly RETAIN_RELEASES="${RETAIN_RELEASES:-5}"
readonly HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
readonly API_SERVICE="${API_SERVICE:-talk-polish-api.service}"
readonly WEB_SERVICE="${WEB_SERVICE:-talk-polish-web.service}"
readonly API_LIVE_URL="${API_LIVE_URL:-http://127.0.0.1:3333/health/live}"
readonly API_READY_URL="${API_READY_URL:-http://127.0.0.1:3333/health/ready}"
readonly WEB_HEALTH_URL="${WEB_HEALTH_URL:-http://127.0.0.1:3000/}"
readonly MINIO_HEALTH_URL="${MINIO_HEALTH_URL:-http://127.0.0.1:9000/minio/health/ready}"
readonly PREPARE_HOOK="${DEPLOY_PREPARE_HOOK:-}"
readonly HEALTH_HOOK="${DEPLOY_HEALTH_HOOK:-}"
readonly SMOKE_HOOK="${DEPLOY_SMOKE_HOOK:-}"
readonly MIGRATION_HOOK="${DEPLOY_MIGRATION_HOOK:-}"
readonly DEPLOY_TEST_MODE="${DEPLOY_TEST_MODE:-0}"

die() { printf 'deploy-host: %s\n' "$*" >&2; exit 1; }
log() { printf 'deploy-host: %s\n' "$*"; }

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || die 'TARGET_SHA must be lowercase 40-hex SHA'
[[ "$DEPLOY_ROOT" = /* && "$REPO_DIR" = /* && "$RELEASES_DIR" = /* ]] || die 'deployment paths must be absolute'
[[ "$RETAIN_RELEASES" =~ ^[1-9][0-9]*$ ]] || die 'RETAIN_RELEASES must be positive integer'
[[ "$HEALTH_RETRIES" =~ ^[1-9][0-9]*$ ]] || die 'HEALTH_RETRIES must be positive integer'
[[ -n "$GITEE_REMOTE" ]] || die 'GITEE_REMOTE is required'
if [[ "$DEPLOY_TEST_MODE" != 1 ]]; then
  [[ "$GITEE_REMOTE" =~ ^(ssh://git@gitee\.com/|git@gitee\.com:)[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$ ]] \
    || die 'GITEE_REMOTE must point to the configured Gitee repository'
fi

mkdir -p "$REPO_DIR" "$RELEASES_DIR" "$DEPLOY_STATE_DIR" "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
"$FLOCK_BIN" -n 9 || die 'another deployment is running'

if [[ ! -d "$REPO_DIR/objects" ]]; then
  git init --bare "$REPO_DIR" >/dev/null
fi
if git --git-dir="$REPO_DIR" remote get-url origin >/dev/null 2>&1; then
  git --git-dir="$REPO_DIR" remote set-url origin "$GITEE_REMOTE"
else
  git --git-dir="$REPO_DIR" remote add origin "$GITEE_REMOTE"
fi

log "fetching exact SHA $TARGET_SHA from Gitee"
git --git-dir="$REPO_DIR" fetch --no-tags --prune origin "$TARGET_SHA"
git --git-dir="$REPO_DIR" cat-file -e "$TARGET_SHA^{commit}" || die 'Gitee did not provide target commit'
if [[ -n "$GITEE_REF" ]]; then
  [[ "$GITEE_REF" =~ ^[A-Za-z0-9._/-]+$ && "$GITEE_REF" != /* && "$GITEE_REF" != *..* ]] || die 'invalid GITEE_REF'
  remote_sha="$(git --git-dir="$REPO_DIR" ls-remote origin "refs/heads/$GITEE_REF" | awk 'NR == 1 { print $1 }')"
  [[ "$remote_sha" == "$TARGET_SHA" ]] || die "Gitee ref $GITEE_REF does not point to target SHA"
fi

read_marker() {
  local file="$1" value=''
  [[ -f "$file" ]] || return 0
  IFS= read -r value <"$file" || true
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] && printf '%s' "$value"
}

old_sha="$(read_marker "$CURRENT_MARKER")"
if [[ -n "$old_sha" ]]; then
  git --git-dir="$REPO_DIR" cat-file -e "$old_sha^{commit}" 2>/dev/null || die 'current marker is not a known commit'
  [[ -L "$CURRENT_LINK" ]] || die 'current marker exists but current symlink is missing'
  [[ "$(readlink "$CURRENT_LINK")" == "$RELEASES_DIR/$old_sha" ]] || die 'current marker and symlink disagree'
fi
if [[ "$old_sha" == "$TARGET_SHA" ]]; then
  if [[ -f "$CURRENT_LINK/apps/web/.output/server/index.mjs" &&
    -d "$CURRENT_LINK/apps/web/.output/public" &&
    -f "$CURRENT_LINK/apps/api/dist/index.js" ]]; then
    log 'target already current; nothing to do'
    exit 0
  fi
  die 'target already current but generated release artifacts are incomplete'
fi

changed_paths=()
if [[ -n "$old_sha" ]]; then
  mapfile -t changed_paths < <(git --git-dir="$REPO_DIR" diff --name-only "$old_sha" "$TARGET_SHA")
else
  mapfile -t changed_paths < <(git --git-dir="$REPO_DIR" ls-tree -r --name-only "$TARGET_SHA")
fi

web_changed=0
api_changed=0
deps_changed=0
migrations_changed=0
# `git archive` contains source only. Every release must materialize both
# runtime build outputs, even when changed paths only contain docs or deploy
# configuration.
web_build_required=1
api_build_required=1
if [[ -z "$old_sha" ]]; then
  web_changed=1
  api_changed=1
  deps_changed=1
fi
for path in "${changed_paths[@]}"; do
  case "$path" in
    apps/web/*) web_changed=1 ;;
    apps/api/*) api_changed=1 ;;
    packages/contracts/*|packages/*|tsconfig*.json|vite.config.*|eslint.config.*|bunfig.toml|package.json|bun.lock)
      web_changed=1; api_changed=1 ;;
  esac
  case "$path" in
    package.json|*/package.json|bun.lock|bunfig.toml) deps_changed=1 ;;
  esac
  [[ "$path" == apps/api/src/db/migrations/* ]] && migrations_changed=1
done

# The active symlink changes for every release. Both services resolve their
# runtime entrypoint through `/opt/kotoba/current`, so both must be restarted
# after the switch even when source changes only touch docs or deploy files.
web_changed=1
api_changed=1

if [[ "$migrations_changed" == 1 && "${ALLOW_MIGRATION:-0}" != 1 ]]; then
  die 'migration files changed; review and run with ALLOW_MIGRATION=1 plus migration hook'
fi

staging="$RELEASES_DIR/.staging-$TARGET_SHA-$$"
cleanup() { [[ -z "$staging" ]] || rm -rf -- "$staging"; }
trap cleanup EXIT
[[ ! -e "$RELEASES_DIR/$TARGET_SHA" ]] || die 'target release directory already exists but is not current'
mkdir -p "$staging"
git --git-dir="$REPO_DIR" archive "$TARGET_SHA" | tar -x -C "$staging"

if [[ "$deps_changed" == 1 || ! -e "$CURRENT_LINK/node_modules" ]]; then
  log 'installing frozen dependencies'
  (cd "$staging" && "$BUN_BIN" install --frozen-lockfile)
else
  # Copy dependency tree instead of linking through `current`: switching the
  # active symlink would otherwise turn the new release's dependency link into
  # a self-reference.
  cp -a -- "$CURRENT_LINK/node_modules" "$staging/node_modules"
fi

if [[ "$web_build_required" == 1 ]]; then
  log 'building web'
  (cd "$staging" && "$BUN_BIN" run build:web)
fi
if [[ "$api_build_required" == 1 ]]; then
  log 'building api'
  (cd "$staging" && "$BUN_BIN" run build:api)
fi

[[ -f "$staging/apps/web/.output/server/index.mjs" &&
  -d "$staging/apps/web/.output/public" ]] || die 'web build artifacts missing'
[[ -f "$staging/apps/api/dist/index.js" ]] || die 'api build artifacts missing'

if [[ -n "$MIGRATION_HOOK" ]]; then
  [[ -x "$MIGRATION_HOOK" ]] || die 'DEPLOY_MIGRATION_HOOK is not executable'
  "$MIGRATION_HOOK" "$staging" "$TARGET_SHA"
elif [[ "$migrations_changed" == 1 ]]; then
  die 'ALLOW_MIGRATION=1 requires executable DEPLOY_MIGRATION_HOOK'
fi
if [[ -n "$PREPARE_HOOK" ]]; then
  [[ -x "$PREPARE_HOOK" ]] || die 'DEPLOY_PREPARE_HOOK is not executable'
  "$PREPARE_HOOK" "$staging" "$TARGET_SHA" "$old_sha"
fi

mv -- "$staging" "$RELEASES_DIR/$TARGET_SHA"
staging=''
atomic_link() {
  local target="$1" link="$2" tmp
  tmp="${link}.tmp-$$"
  ln -s -- "$target" "$tmp"
  # Linux production uses atomic rename; macOS test hosts lack mv -T.
  if mv -Tf -- "$tmp" "$link" 2>/dev/null; then
    :
  else
    rm -f -- "$link"
    mv -f -- "$tmp" "$link"
  fi
}
write_marker() {
  local value="$1" file="$2" tmp
  tmp="${file}.tmp-$$"
  printf '%s\n' "$value" >"$tmp"
  chmod 0644 "$tmp"
  mv -f -- "$tmp" "$file"
}

if [[ -n "$old_sha" ]]; then write_marker "$old_sha" "$PREVIOUS_MARKER"; fi
atomic_link "$RELEASES_DIR/$TARGET_SHA" "$CURRENT_LINK"
switched=1

rollback() {
  local status=$?
  trap - EXIT
  if [[ "${switched:-0}" == 1 && -n "$old_sha" ]]; then
    log 'deploy failed; restoring previous release'
    atomic_link "$RELEASES_DIR/$old_sha" "$CURRENT_LINK"
    "$SYSTEMCTL_BIN" restart "$API_SERVICE" "$WEB_SERVICE" >/dev/null 2>&1 || true
  elif [[ "${switched:-0}" == 1 ]]; then
    rm -f -- "$CURRENT_LINK"
    # On a first deployment there is no previous systemd release to restore.
    # Stop services that may still be starting against the removed symlink.
    "$SYSTEMCTL_BIN" stop "$API_SERVICE" "$WEB_SERVICE" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$RELEASES_DIR/$TARGET_SHA" "$staging"
  exit "$status"
}
trap rollback EXIT

if [[ "$api_changed" == 1 ]]; then "$SYSTEMCTL_BIN" restart "$API_SERVICE"; fi
if [[ "$web_changed" == 1 ]]; then "$SYSTEMCTL_BIN" restart "$WEB_SERVICE"; fi

wait_for_health() {
  local url="$1" label="$2" attempt
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if "$CURL_BIN" -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "$label failed"
}

if [[ -n "$HEALTH_HOOK" ]]; then
  [[ -x "$HEALTH_HOOK" ]] || die 'DEPLOY_HEALTH_HOOK is not executable'
  "$HEALTH_HOOK" "$RELEASES_DIR/$TARGET_SHA" "$TARGET_SHA"
else
  if [[ "$api_changed" == 1 ]]; then wait_for_health "$API_LIVE_URL" 'API liveness'; fi
  if [[ "$api_changed" == 1 ]]; then wait_for_health "$API_READY_URL" 'API readiness'; fi
  if [[ "$api_changed" == 1 ]]; then wait_for_health "$MINIO_HEALTH_URL" 'MinIO readiness'; fi
  if [[ "$web_changed" == 1 ]]; then wait_for_health "$WEB_HEALTH_URL" 'web health'; fi
fi
if [[ -n "$SMOKE_HOOK" ]]; then
  [[ -x "$SMOKE_HOOK" ]] || die 'DEPLOY_SMOKE_HOOK is not executable'
  "$SMOKE_HOOK" "$RELEASES_DIR/$TARGET_SHA" "$TARGET_SHA"
fi

write_marker "$TARGET_SHA" "$CURRENT_MARKER"
cleanup_old_releases() {
  local keep=0 release
  while IFS= read -r release; do
    [[ -n "$release" ]] || continue
    if [[ "$release" == "$RELEASES_DIR/$TARGET_SHA" || "$release" == "$RELEASES_DIR/$old_sha" ]]; then
      continue
    fi
    keep=$((keep + 1))
    (( keep <= RETAIN_RELEASES )) || rm -rf -- "$release"
  done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]'\''\''*' -print | sort -r)
}
cleanup_old_releases
trap - EXIT
log "deployed $TARGET_SHA (web=$web_changed api=$api_changed install=$deps_changed)"
