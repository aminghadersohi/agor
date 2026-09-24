#!/bin/bash
#
# Adopt personal/amin_dev_next as amin_dev on the live checkout.
#
# Certified 2026-09-24 against a pg_restore of the live database. Run it from
# the live checkout with nothing else running against that database.
#
#   cd ~/code/github/preset-io/agor && bash /path/to/adopt-amin-dev-next.sh
#
# It is deliberately NOT part of the commit it adopts: the script hardcodes the
# SHA it certified, and a file inside that commit cannot contain its own commit
# hash. Keep this copy (or the one in the handover report) outside the branch.
#
# On failure after the branch is renamed it stops and prints the rollback
# commands. It never rolls back on its own and it never stashes.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Constants certified by the integration run
# ---------------------------------------------------------------------------
readonly LIVE_CHECKOUT="$HOME/code/github/preset-io/agor"
readonly CERTIFIED_SHA="b666189d58825aaa63dcdce49ea4c7f6b4d94999"
readonly BACKUP_TAG="backup/amin_dev-20260924T052347Z"
readonly DB_NAME="agor"
# pg_dump and the migration both need a role that owns the schema. The URL in
# ~/.agor/config.yaml is the runtime role agor_runtime_b6cf7657c9, which cannot
# read mcp_servers_delete_audit and cannot CREATE in the public schema — both
# were reproduced against a restored copy, and both abort this deploy.
readonly DB_SUPERUSER="amin"
readonly PG_BIN="/opt/homebrew/opt/postgresql@15/bin"
readonly DAEMON_LABEL="com.agor.daemon"
readonly UI_LABEL="com.agor.ui"
readonly DAEMON_PLIST="$HOME/Library/LaunchAgents/com.agor.daemon.plist"
readonly UI_PLIST="$HOME/Library/LaunchAgents/com.agor.ui.plist"
readonly DAEMON_PORT=3030
readonly UI_PORT=5173

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly STAMP
readonly OLD_BRANCH="amin_dev_old_${STAMP}"
readonly DUMP_FILE="$HOME/.agor/backups/agor-pre-adopt-${STAMP}.dump"

export PATH="$PG_BIN:$PATH"

RENAMED=0

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
# Every abort path goes through here, so the rollback notice is printed once,
# by whichever of die/on_error fires first, and only after the branch moved.
NOTICE_SHOWN=0
die()  {
  printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2
  if [ "$RENAMED" -eq 1 ] && [ "$NOTICE_SHOWN" -eq 0 ]; then
    NOTICE_SHOWN=1
    rollback_notice
  fi
  exit 1
}

rollback_notice() {
  cat >&2 <<EOF

--------------------------------------------------------------------------
ROLLBACK (run these by hand — this script will not undo anything for you)
--------------------------------------------------------------------------
  cd "$LIVE_CHECKOUT"
  git checkout "$OLD_BRANCH"
  git branch -D amin_dev
  git branch -m "$OLD_BRANCH" amin_dev
  pnpm install --frozen-lockfile

  # Only if the migration ran and you need the pre-adopt database back.
  # This DROPS the live database. Stop both services first.
  launchctl bootout "gui/\$(id -u)/$DAEMON_LABEL" || true
  launchctl bootout "gui/\$(id -u)/$UI_LABEL" || true
  $PG_BIN/dropdb   -h localhost -U $DB_SUPERUSER $DB_NAME
  $PG_BIN/createdb -h localhost -U $DB_SUPERUSER -O $DB_SUPERUSER $DB_NAME
  $PG_BIN/pg_restore -h localhost -U $DB_SUPERUSER -d $DB_NAME -j 4 "$DUMP_FILE"

  # Bring the services back up.
  launchctl bootstrap "gui/\$(id -u)" "$DAEMON_PLIST"
  launchctl bootstrap "gui/\$(id -u)" "$UI_PLIST"

  Branch backup tag (unchanged by this script): $BACKUP_TAG
  Database dump taken by this run:              $DUMP_FILE
--------------------------------------------------------------------------
EOF
}

on_error() {
  local line=$1
  printf '\n\033[31mAborted at line %s.\033[0m\n' "$line" >&2
  if [ "$RENAMED" -eq 1 ] && [ "$NOTICE_SHOWN" -eq 0 ]; then
    NOTICE_SHOWN=1
    rollback_notice
  fi
  exit 1
}
trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
say "1/7 Preflight"

[ "$(pwd -P)" = "$(cd "$LIVE_CHECKOUT" && pwd -P)" ] \
  || die "run this from $LIVE_CHECKOUT (currently $(pwd -P))"
ok "cwd is the live checkout"

[ -z "$(git status --porcelain)" ] \
  || die "working tree is dirty. Commit or discard by hand — this script will not stash."
ok "working tree clean"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$current_branch" = "amin_dev" ] \
  || die "expected to be on amin_dev, found '$current_branch'"
ok "on amin_dev"

for tool in git pnpm curl lsof launchctl "$PG_BIN/pg_dump" "$PG_BIN/psql"; do
  command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ] || die "missing required tool: $tool"
done
ok "required tools present"

git fetch personal --prune --tags
ok "fetched personal"

fetched="$(git rev-parse personal/amin_dev_next)"
[ "$fetched" = "$CERTIFIED_SHA" ] \
  || die "personal/amin_dev_next is $fetched, not the certified $CERTIFIED_SHA"
ok "personal/amin_dev_next == $CERTIFIED_SHA"

git rev-parse -q --verify "refs/tags/$BACKUP_TAG^{commit}" >/dev/null \
  || die "backup tag $BACKUP_TAG not found"
ok "backup tag $BACKUP_TAG present"

"$PG_BIN/psql" -h localhost -U "$DB_SUPERUSER" -d "$DB_NAME" -tAc 'select 1' >/dev/null \
  || die "cannot reach database '$DB_NAME' as $DB_SUPERUSER"
ok "database reachable as $DB_SUPERUSER"

# ---------------------------------------------------------------------------
# 2. Database backup
# ---------------------------------------------------------------------------
say "2/7 Dumping the live database"

mkdir -p "$(dirname "$DUMP_FILE")"
"$PG_BIN/pg_dump" -Fc -h localhost -U "$DB_SUPERUSER" -d "$DB_NAME" -f "$DUMP_FILE" \
  || die "pg_dump failed — nothing has been changed"
[ -s "$DUMP_FILE" ] || die "pg_dump produced an empty file: $DUMP_FILE"
"$PG_BIN/pg_restore" -l "$DUMP_FILE" >/dev/null \
  || die "dump is not a readable archive: $DUMP_FILE"
ok "dump: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

# ---------------------------------------------------------------------------
# 3. Stop the services
#
# The pending set includes 9021_gateway_outbound_thread_seed, which the CLI
# classifies as an offline cutover: old and new daemons must not index this
# database concurrently. Both units are KeepAlive=true, so `kill` would just
# bring them back — bootout is what actually stops them.
# ---------------------------------------------------------------------------
say "3/7 Stopping daemon and UI for the offline cutover"

launchctl bootout "gui/$(id -u)/$DAEMON_LABEL" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$UI_LABEL" 2>/dev/null || true
for _ in $(seq 1 30); do
  lsof -nP -iTCP:$DAEMON_PORT -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 1
done
lsof -nP -iTCP:$DAEMON_PORT -sTCP:LISTEN >/dev/null 2>&1 \
  && die "something is still listening on :$DAEMON_PORT"
ok "daemon and UI stopped"

# ---------------------------------------------------------------------------
# 4. Swap the branch
#
# Renaming the checked-out branch moves HEAD with it, so after the rename the
# checkout sits on the renamed old branch. Create amin_dev explicitly from the
# certified ref rather than renaming a second time.
# ---------------------------------------------------------------------------
say "4/7 Swapping amin_dev -> $OLD_BRANCH and checking out the certified tree"

git branch -m amin_dev "$OLD_BRANCH"
RENAMED=1
git checkout -b amin_dev "$CERTIFIED_SHA"

head_now="$(git rev-parse HEAD)"
[ "$head_now" = "$CERTIFIED_SHA" ] || die "HEAD is $head_now, expected $CERTIFIED_SHA"
[ "$(git rev-parse --abbrev-ref HEAD)" = "amin_dev" ] || die "not on amin_dev after checkout"
git branch --set-upstream-to=personal/amin_dev_next amin_dev >/dev/null 2>&1 || true
ok "amin_dev @ $CERTIFIED_SHA (previous branch kept as $OLD_BRANCH)"

# ---------------------------------------------------------------------------
# 5. Install, build, migrate
# ---------------------------------------------------------------------------
say "5/7 Installing, building and migrating"

pnpm install --frozen-lockfile || die "pnpm install --frozen-lockfile failed"
ok "dependencies installed"

pnpm exec turbo run build --filter='!@agor/docs' || die "build failed"
ok "build complete"

# Certified pending set, in order:
#   9021_gateway_outbound_thread_seed   9026_branch_color_override
#   0111_management_ownership_transfer  0112_kb_import_receipts
#   0113_session_recency_not_null       0114_mcp_slack_connect_due
#   9028_profile_image_galleries        0113_callback_ownership_reconciliation
DATABASE_URL="postgresql://${DB_SUPERUSER}@localhost:5432/${DB_NAME}" \
  pnpm -w agor db migrate -y --offline-cutover \
  || die "migrations failed — the database is unchanged (drizzle applies the batch in one transaction)"
ok "migrations applied"

# `db status` lists applied migrations and only grows a "Pending migrations"
# section when work remains; it has no positive "up to date" line to match on.
if DATABASE_URL="postgresql://${DB_SUPERUSER}@localhost:5432/${DB_NAME}" \
     pnpm -w agor db status 2>&1 | grep -q 'Pending migrations'; then
  die "migrations reported success but the database still has pending work"
fi
ok "no pending migrations remain"

# ---------------------------------------------------------------------------
# 6. Start the services — daemon first, then UI
# ---------------------------------------------------------------------------
say "6/7 Starting daemon, then UI"

launchctl bootstrap "gui/$(id -u)" "$DAEMON_PLIST" 2>/dev/null \
  || launchctl kickstart -k "gui/$(id -u)/$DAEMON_LABEL" \
  || die "could not start $DAEMON_LABEL"

daemon_up=0
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$DAEMON_PORT/health" >/dev/null 2>&1; then daemon_up=1; break; fi
  sleep 2
done
[ "$daemon_up" -eq 1 ] \
  || die "daemon did not become healthy on :$DAEMON_PORT within 240s (see ~/.agor/logs/launchd-daemon.log)"
ok "daemon healthy on :$DAEMON_PORT"

launchctl bootstrap "gui/$(id -u)" "$UI_PLIST" 2>/dev/null \
  || launchctl kickstart -k "gui/$(id -u)/$UI_LABEL" \
  || die "could not start $UI_LABEL"

ui_up=0
for _ in $(seq 1 120); do
  if curl -fsSI "http://localhost:$UI_PORT/" >/dev/null 2>&1; then ui_up=1; break; fi
  sleep 2
done
[ "$ui_up" -eq 1 ] \
  || die "UI did not answer on :$UI_PORT within 240s (see ~/.agor/logs/launchd-ui.log)"
ok "UI answering on :$UI_PORT"

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------
say "7/7 Verifying"

curl -fsS "http://localhost:$DAEMON_PORT/health" >/dev/null || die "daemon health check failed"
ok "GET :$DAEMON_PORT/health"

curl -fsSI "http://localhost:$UI_PORT/" >/dev/null || die "UI HEAD check failed"
ok "HEAD :$UI_PORT/"

# Vite falls forward to 5174+ when 5173 is taken, which silently leaves the
# browser pointed at a stale server. Treat that as a failure, not a warning.
#
# Checking the listener's *name* does not work: it is `node`, not `vite`. What
# actually distinguishes "our UI owns 5173" from "someone else does and our UI
# fell forward" is process ancestry, so walk from the listener up to the
# com.agor.ui service pid.
ui_service_pid="$(launchctl print "gui/$(id -u)/$UI_LABEL" 2>/dev/null \
  | awk -F'= *' '/^\tpid = /{print $2; exit}' || true)"
[ -n "$ui_service_pid" ] || die "could not read the pid of $UI_LABEL"

listener_pid="$(lsof -nP -iTCP:$UI_PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$listener_pid" ] || die "nothing is listening on :$UI_PORT"

owned_by_ui=0
walk="$listener_pid"
for _ in $(seq 1 8); do
  if [ "$walk" = "$ui_service_pid" ]; then owned_by_ui=1; break; fi
  walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -d ' ')"
  [ -n "$walk" ] || break
  [ "$walk" = "1" ] && break
done
[ "$owned_by_ui" -eq 1 ] \
  || die ":$UI_PORT is held by pid $listener_pid, which is not part of $UI_LABEL — vite has fallen forward, check ~/.agor/logs/launchd-ui.log"

for extra in 5174 5175 5176 5177; do
  extra_pid="$(lsof -nP -iTCP:$extra -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$extra_pid" ] || continue
  w="$extra_pid"
  for _ in $(seq 1 8); do
    if [ "$w" = "$ui_service_pid" ]; then
      die "$UI_LABEL fell forward onto :$extra — it must own :$UI_PORT"
    fi
    w="$(ps -o ppid= -p "$w" 2>/dev/null | tr -d ' ')"
    [ -n "$w" ] || break
    [ "$w" = "1" ] && break
  done
done
ok "$UI_LABEL owns :$UI_PORT, no fall-forward"

[ "$(git rev-parse HEAD)" = "$CERTIFIED_SHA" ] || die "HEAD drifted from the certified SHA"
ok "HEAD still $CERTIFIED_SHA"

cat <<EOF

--------------------------------------------------------------------------
Adopted.

  amin_dev            $CERTIFIED_SHA
  previous branch     $OLD_BRANCH (kept; delete it once you are happy)
  branch backup tag   $BACKUP_TAG
  database dump       $DUMP_FILE
  daemon log          ~/.agor/logs/launchd-daemon.log
  ui log              ~/.agor/logs/launchd-ui.log
--------------------------------------------------------------------------
EOF
