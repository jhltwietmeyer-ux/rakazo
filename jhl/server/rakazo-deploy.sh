#!/usr/bin/env bash
# Pull-based deploy for Johann's single-VM Rakazo stack.
#
# Installed as /root/rakazo-deploy.sh (a copy of jhl/server/rakazo-deploy.sh) and run by root's
# cron every two minutes through /etc/cron.d/rakazo-deploy. Each run fetches origin/deploy and
# exits silently when that commit equals the checkout's HEAD. Otherwise it resets the checkout,
# builds the images with GIT_SHA, recreates the stack with both production Compose files, checks
# the public /health endpoint and writes one result line to /var/log/rakazo-deploy.log. Build and
# start output goes to /var/log/rakazo-deploy-last.log (overwritten per deploy). It never prompts.
#
# Why root cron, with git running as the deploy user:
# - harden-host.sh only admits the key-only deploy user over SSH and grants it no sudo rule.
#   infra/compose/deploy-main.sh runs as that user and needs passwordless sudo for Docker because
#   CI reaches it through a forced SSH command. Nothing logs in here: cron runs locally, so root
#   talks to Docker directly and the script depends on no sudoers entry.
# - /srv/rakazo belongs to deploy and the read-only GitHub deploy key lives in ~deploy/.ssh, so
#   every git command runs as deploy. That keeps ownership of the checkout stable and avoids git's
#   "dubious ownership" refusal for root. setpriv switches user without PAM, so a run every two
#   minutes does not fill auth.log the way sudo or runuser would.
#
# Differences to deploy-main.sh: branch deploy instead of main, the Docker overlay in every
# Compose call, a GIT_SHA build arg, up --wait --pull never, a silent no-op when nothing changed,
# a held lock is not an error (the next tick retries), and no automatic rollback. A failed deploy
# leaves HEAD on the new commit, so it is not retried every two minutes; push a fix to deploy or
# run this script with --force.
#
# Usage: rakazo-deploy.sh [--force]
#   --force  rebuild and restart even when HEAD already equals origin/deploy.
#
# The domain comes from DOMAIN= in /etc/rakazo-deploy.conf, otherwise from RAKAZO_HOST= in .env.

set -Eeuo pipefail

REPO_DIR=/srv/rakazo
BRANCH=deploy
DEPLOY_USER=deploy
ENV_FILE="${REPO_DIR}/.env"
CONF_FILE=/etc/rakazo-deploy.conf
LOG_FILE=/var/log/rakazo-deploy.log
DETAIL_LOG=/var/log/rakazo-deploy-last.log
LOCK_FILE=/run/lock/rakazo-deploy.lock
PULL_TIMEOUT=10m
BUILD_TIMEOUT=45m
UP_TIMEOUT=10m
HEALTH_TIMEOUT_S=60
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

COMPOSE=(docker compose --env-file "${ENV_FILE}"
  -f "${REPO_DIR}/infra/compose/docker-compose.prod.yml"
  -f "${REPO_DIR}/infra/compose/docker-compose.prod.docker.yml")

force=0
case "${1:-}" in
  "") ;;
  --force) force=1 ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac

if [[ "${EUID}" -ne 0 ]]; then
  echo "run as root (sudo $0)" >&2
  exit 2
fi

# Cron output goes only to the log; a manual run in a terminal also shows it.
if [[ -t 1 ]]; then
  exec > >(tee -a "${LOG_FILE}") 2>&1
else
  exec >>"${LOG_FILE}" 2>&1
fi

# A deploy that is still building holds the lock; this tick simply ends.
exec 9>"${LOCK_FILE}"
flock -n 9 || exit 0

log() {
  printf '%s %s\n' "$(date '+%F %T %Z')" "$*"
}

# Strip optional quotes and CR so KEY="value" and KEY=value both work. Never sources the file.
read_value() {
  local file="$1" key="$2"
  [[ -r "${file}" ]] || return 0
  sed -n "s/^${key}=//p" "${file}" | tail -n 1 | tr -d "\"' \r"
}

deploy_uid="$(id -u "${DEPLOY_USER}")"
deploy_gid="$(id -g "${DEPLOY_USER}")"
deploy_home="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"

as_deploy_git() {
  setpriv --reuid="${deploy_uid}" --regid="${deploy_gid}" --init-groups -- \
    env -i HOME="${deploy_home}" USER="${DEPLOY_USER}" LOGNAME="${DEPLOY_USER}" \
    PATH="${PATH}" LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0 \
    git -C "${REPO_DIR}" -c core.sshCommand="ssh -o BatchMode=yes" "$@"
}

cd "${REPO_DIR}"

if ! fetch_output="$(as_deploy_git fetch --quiet --prune origin "${BRANCH}" 2>&1)"; then
  log "ERROR git fetch origin ${BRANCH} failed: ${fetch_output}"
  exit 1
fi

current="$(as_deploy_git rev-parse HEAD)"
target="$(as_deploy_git rev-parse "origin/${BRANCH}")"

if [[ "${current}" == "${target}" && "${force}" -eq 0 ]]; then
  exit 0
fi

domain="$(read_value "${CONF_FILE}" DOMAIN)"
[[ -n "${domain}" ]] || domain="$(read_value "${ENV_FILE}" RAKAZO_HOST)"
if [[ -z "${domain}" ]]; then
  log "ERROR no domain: set DOMAIN in ${CONF_FILE} or RAKAZO_HOST in ${ENV_FILE}"
  exit 1
fi
if [[ ! -r "${ENV_FILE}" ]]; then
  log "ERROR ${ENV_FILE} is missing"
  exit 1
fi

on_error() {
  local rc=$?
  trap - ERR
  log "FAILED deploy ${target:0:12} (exit ${rc}); details in ${DETAIL_LOG}"
  echo "--- last lines of ${DETAIL_LOG}"
  tail -n 30 "${DETAIL_LOG}" 2>/dev/null || true
  echo "--- docker compose logs --tail 50"
  "${COMPOSE[@]}" logs --no-color --tail 50 2>&1 || true
  echo "--- end"
  exit "${rc}"
}
trap on_error ERR

started=${SECONDS}
if [[ "${current}" == "${target}" ]]; then
  log "START forced redeploy of ${target:0:12}"
else
  log "START deploy ${current:0:12} -> ${target:0:12}"
fi

: >"${DETAIL_LOG}"
as_deploy_git reset --hard --quiet "${target}"
# Validates interpolation (missing .env values) without printing the resolved config.
"${COMPOSE[@]}" config --quiet >>"${DETAIL_LOG}" 2>&1
# up --pull never needs postgres, caddy and busybox locally, including after a digest bump.
timeout --kill-after=30s "${PULL_TIMEOUT}" \
  "${COMPOSE[@]}" pull --quiet --ignore-buildable >>"${DETAIL_LOG}" 2>&1
timeout --kill-after=30s "${BUILD_TIMEOUT}" \
  "${COMPOSE[@]}" build --build-arg GIT_SHA="${target}" >>"${DETAIL_LOG}" 2>&1
timeout --kill-after=30s "${UP_TIMEOUT}" \
  "${COMPOSE[@]}" up -d --wait --wait-timeout 300 --pull never >>"${DETAIL_LOG}" 2>&1

healthy=0
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
while ((SECONDS < deadline)); do
  if curl --fail --silent --show-error --max-time 10 --output /dev/null \
    "https://${domain}/health" >>"${DETAIL_LOG}" 2>&1; then
    healthy=1
    break
  fi
  sleep 5
done
if [[ "${healthy}" -ne 1 ]]; then
  log "ERROR https://${domain}/health not healthy after ${HEALTH_TIMEOUT_S}s"
  false
fi

trap - ERR
# Only dangling layers from the replaced build; tagged images and volumes stay.
docker image prune -f >>"${DETAIL_LOG}" 2>&1 || true
log "OK deployed ${target:0:12} in $((SECONDS - started))s, https://${domain}/health 200"
