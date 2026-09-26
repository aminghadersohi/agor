#!/bin/bash
#
# Adopt personal/amin_dev_next-20260926 as amin_dev on the live checkout.
#
# Certified 2026-09-26 against a pg_restore of the live database (dump taken
# 2026-09-26T10:45:48Z, ledger 129 rows, watermark 1790129000215). Run it from
# the live checkout:
#
#   cd ~/code/github/preset-io/agor && bash /tmp/adopt-amin-dev-next-20260926.sh
#
# It is deliberately NOT part of the commit it adopts: the script hardcodes the
# SHA it certified, and a file inside that commit cannot contain its own hash.
#
# Derived from the hardened 2026-09-24 script (ec3bf065a). Differences:
#   - preflight asserts the live checkout is on the previously adopted commit
#     and that the database ledger is exactly the state this run was certified
#     against (row count, watermark, and the hash of the profile-image row),
#     then asserts the pending set is exactly 9030_branch_front_desk_sessions
#     BEFORE anything is stopped;
#   - the grant step no longer runs ALTER DEFAULT PRIVILEGES. The live database
#     has no default ACLs (the 2026-09-24 cutover left explicit per-table
#     grants only), so this run keeps that model and grants the one new table
#     explicitly;
#   - post-migration it asserts the ledger, the new table's shape and RLS, a
#     single profile_images table and an unchanged profile_images row count.
#
# Order matters: the services are stopped BEFORE the database is dumped, so the
# dump is a quiesced snapshot. On failure after the branch is renamed it stops
# and prints rollback instructions. It never rolls back on its own, never kills
# a process that is holding the database, and never stashes.

set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Constants certified by the integration run
# ---------------------------------------------------------------------------
readonly LIVE_CHECKOUT="$HOME/code/github/preset-io/agor"
readonly CERTIFIED_REF="personal/amin_dev_next-20260926"
readonly CERTIFIED_SHA="bdfe709049a44bff54f5615a7dbb8bfcb0044a62"
# What live runs today (adopted 2026-09-24). Also kept on the remote as
# personal/amin_dev_next-20260924T064923Z, which is the branch rollback target.
readonly PREVIOUS_SHA="b666189d58825aaa63dcdce49ea4c7f6b4d94999"
readonly PREVIOUS_REF="personal/amin_dev_next-20260924T064923Z"
readonly DB_NAME="agor"
# Migrations and pg_dump need the role that owns the schema. The URL in
# ~/.agor/config.yaml is the runtime role, which cannot read
# mcp_servers_delete_audit and cannot CREATE in the public schema.
readonly DB_OWNER="amin"
readonly RUNTIME_ROLE="agor_runtime_b6cf7657c9"
readonly PG_BIN="/opt/homebrew/opt/postgresql@15/bin"
readonly DAEMON_LABEL="com.agor.daemon"
readonly UI_LABEL="com.agor.ui"
readonly DAEMON_PLIST="$HOME/Library/LaunchAgents/com.agor.daemon.plist"
readonly UI_PLIST="$HOME/Library/LaunchAgents/com.agor.ui.plist"
readonly DAEMON_PORT=3030
readonly UI_PORT=5173

# Ledger state the certification ran against, and the state it must end in.
readonly LEDGER_ROWS_BEFORE=129
readonly WATERMARK_BEFORE=1790129000215
# drizzle hash (sha256 of the SQL file) of 9028_profile_image_galleries as
# applied on live at 1790129000214. Proves the collision slot holds profile
# images, not fork main's front desk.
readonly PROFILE_ROW_WHEN=1790129000214
readonly PROFILE_ROW_HASH="b864cf55b11b618c8d9e979c5341539f8727a6c2dc7bb3e821089fdbdbe8375d"
readonly EXPECTED_PENDING="9030_branch_front_desk_sessions"
readonly LEDGER_ROWS_AFTER=130
readonly WATERMARK_AFTER=1790208000001

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
readonly STAMP
readonly OLD_BRANCH="amin_dev_old_${STAMP}"
# Lowercased on purpose: an unquoted ALTER DATABASE ... RENAME TO folds the
# identifier, so a mixed-case stamp would name a different database than every
# later command in the rollback notice expects.
FAILED_DB="agor_failed_$(printf '%s' "$STAMP" | tr '[:upper:]' '[:lower:]')"
readonly FAILED_DB
readonly DUMP_FILE="$HOME/.agor/backups/agor-pre-adopt-${STAMP}.dump"

export PATH="$PG_BIN:$PATH"

RENAMED=0
MIGRATED=0
NOTICE_SHOWN=0

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32mok\033[0m  %s\n' "$*"; }
note() { printf '    \033[33m--\033[0m  %s\n' "$*"; }

rollback_notice() {
  cat >&2 <<EOF

--------------------------------------------------------------------------
ROLLBACK (run these by hand — this script will not undo anything for you)
--------------------------------------------------------------------------
Branch:

  cd "$LIVE_CHECKOUT"
  git checkout "$OLD_BRANCH"
  git branch -D amin_dev
  git branch -m "$OLD_BRANCH" amin_dev
  pnpm install --frozen-lockfile
  pnpm exec turbo run build --filter='!@agor/docs'

Database — REQUIRED if the migration ran (migrated=$MIGRATED). The previous
binary refuses to start against a database whose watermark is newer than its
own journal ("Database schema is newer than this Agor binary"). This does NOT
drop anything: the failed database is renamed aside and the dump is restored
into a fresh one. Both services must be stopped first.

  launchctl bootout "gui/\$(id -u)/$DAEMON_LABEL" || true
  launchctl bootout "gui/\$(id -u)/$UI_LABEL" || true

  $PG_BIN/psql -h localhost -U $DB_OWNER -d postgres \\
    -c 'ALTER DATABASE "$DB_NAME" RENAME TO "$FAILED_DB";'
  $PG_BIN/createdb -h localhost -U $DB_OWNER -O $DB_OWNER "$DB_NAME"
  $PG_BIN/pg_restore -h localhost -U $DB_OWNER -d "$DB_NAME" -j 4 "$DUMP_FILE"

  # Inspect the failed state later with:
  #   $PG_BIN/psql -h localhost -U $DB_OWNER -d "$FAILED_DB"
  # and drop it only once you are done:
  #   $PG_BIN/dropdb -h localhost -U $DB_OWNER "$FAILED_DB"

Restart:

  launchctl bootstrap "gui/\$(id -u)" "$DAEMON_PLIST"
  launchctl bootstrap "gui/\$(id -u)" "$UI_PLIST"

  Previous commit:               $PREVIOUS_SHA ($PREVIOUS_REF)
  Database dump taken by this run: $DUMP_FILE
--------------------------------------------------------------------------
EOF
}

maybe_notice() {
  if [ "$RENAMED" -eq 1 ] && [ "$NOTICE_SHOWN" -eq 0 ]; then
    NOTICE_SHOWN=1
    rollback_notice
  fi
}

die() {
  printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2
  maybe_notice
  exit 1
}

on_error() {
  printf '\n\033[31mAborted at line %s.\033[0m\n' "$1" >&2
  maybe_notice
  exit 1
}
trap 'on_error $LINENO' ERR

# psql as the owning role, returning a single unaligned value.
q() { "$PG_BIN/psql" -h localhost -U "$DB_OWNER" -d "$1" -XtAc "$2"; }

owner_url="postgresql://${DB_OWNER}@localhost:5432/${DB_NAME}"

# `agor db status` as the owning role. A crashed command produces no output,
# and grepping output alone would read that as "nothing pending", so status and
# output are captured separately and the output must be recognisable.
db_status() {
  local rc=0 out
  out="$(DATABASE_URL="$owner_url" pnpm -w agor db status 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || die "'agor db status' exited $rc; output was: $(printf '%s' "$out" | tail -5)"
  printf '%s' "$out" | grep -q 'Total: [0-9]* migration' \
    || die "'agor db status' output was not recognisable: $(printf '%s' "$out" | tail -5)"
  printf '%s' "$out"
}

# Pending tags, one per line, from `agor db status` output ("  • <tag>").
pending_of() { printf '%s\n' "$1" | sed -n 's/^[[:space:]]*•[[:space:]]*\([0-9A-Za-z_]*\).*$/\1/p'; }

# ---------------------------------------------------------------------------
# 1. Preflight — everything here is read-only
# ---------------------------------------------------------------------------
say "1/8 Preflight"

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

[ "$(git rev-parse HEAD)" = "$PREVIOUS_SHA" ] \
  || die "amin_dev is at $(git rev-parse HEAD), not the previously adopted $PREVIOUS_SHA. This script was certified against an upgrade from that commit only."
ok "amin_dev == $PREVIOUS_SHA (the commit this upgrade was certified from)"

for tool in git pnpm curl lsof launchctl ps python3 \
            "$PG_BIN/pg_dump" "$PG_BIN/pg_restore" "$PG_BIN/psql" "$PG_BIN/createdb"; do
  command -v "$tool" >/dev/null 2>&1 || [ -x "$tool" ] || die "missing required tool: $tool"
done
ok "required tools present"

git fetch personal --prune --tags
ok "fetched personal"

fetched="$(git rev-parse "$CERTIFIED_REF")"
[ "$fetched" = "$CERTIFIED_SHA" ] \
  || die "$CERTIFIED_REF is $fetched, not the certified $CERTIFIED_SHA"
ok "$CERTIFIED_REF == $CERTIFIED_SHA"

[ "$(git rev-parse "$PREVIOUS_REF")" = "$PREVIOUS_SHA" ] \
  || die "$PREVIOUS_REF no longer points at $PREVIOUS_SHA; the rollback target is not preserved"
ok "rollback ref $PREVIOUS_REF == $PREVIOUS_SHA"

git merge-base --is-ancestor "$PREVIOUS_SHA" "$CERTIFIED_SHA" \
  || die "$CERTIFIED_SHA does not descend from $PREVIOUS_SHA"
ok "certified commit descends from the live commit"

EXPECTED_BUILD_SHA="$(git rev-parse --short "$CERTIFIED_SHA")"
readonly EXPECTED_BUILD_SHA
ok "expected /health buildSha after cutover: $EXPECTED_BUILD_SHA"

q "$DB_NAME" 'select 1' >/dev/null || die "cannot reach database '$DB_NAME' as $DB_OWNER"
ok "database reachable as $DB_OWNER"

[ "$(q "$DB_NAME" "select count(*) from pg_roles where rolname='$RUNTIME_ROLE'")" = "1" ] \
  || die "runtime role $RUNTIME_ROLE does not exist"
ok "runtime role $RUNTIME_ROLE exists"

ledger="$(q "$DB_NAME" "select count(*)||' '||max(created_at) from drizzle.__drizzle_migrations")"
[ "$ledger" = "$LEDGER_ROWS_BEFORE $WATERMARK_BEFORE" ] \
  || die "migration ledger is '$ledger', expected '$LEDGER_ROWS_BEFORE $WATERMARK_BEFORE'. The database is not in the state this run was certified against."
ok "ledger: $LEDGER_ROWS_BEFORE rows, watermark $WATERMARK_BEFORE"

profile_hash="$(q "$DB_NAME" "select hash from drizzle.__drizzle_migrations where created_at=$PROFILE_ROW_WHEN")"
[ "$profile_hash" = "$PROFILE_ROW_HASH" ] \
  || die "ledger row at $PROFILE_ROW_WHEN has hash '$profile_hash', not 9028_profile_image_galleries ($PROFILE_ROW_HASH)"
ok "ledger slot $PROFILE_ROW_WHEN holds 9028_profile_image_galleries"

[ "$(q "$DB_NAME" "select to_regclass('public.branch_front_desk_sessions') is null")" = "t" ] \
  || die "branch_front_desk_sessions already exists; this database is not the certified state"
[ "$(q "$DB_NAME" "select count(*) from pg_class where relname='profile_images' and relkind='r'")" = "1" ] \
  || die "expected exactly one profile_images table"
PROFILE_ROWS_BEFORE="$(q "$DB_NAME" "select count(*) from public.profile_images")"
readonly PROFILE_ROWS_BEFORE
ok "front desk absent, one profile_images table ($PROFILE_ROWS_BEFORE rows)"

# ---------------------------------------------------------------------------
# 2. Stop the services, and prove they are stopped
#
# Both units are KeepAlive=true, so `kill` would just bring them back —
# bootout is what actually stops them.
# ---------------------------------------------------------------------------
say "2/8 Stopping daemon and UI, and verifying the database is quiesced"

stop_unit() {
  local label="$1" rc=0
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || rc=$?
  # 0 = stopped, 3 = "No such process" i.e. it was not loaded. Anything else is
  # a real failure and must not be swallowed.
  case "$rc" in
    0) ok "bootout $label" ;;
    3) note "$label was not loaded" ;;
    *) die "launchctl bootout $label failed with exit $rc" ;;
  esac
}
stop_unit "$DAEMON_LABEL"
stop_unit "$UI_LABEL"

for label in "$DAEMON_LABEL" "$UI_LABEL"; do
  gone=0
  for _ in $(seq 1 30); do
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then gone=1; break; fi
    sleep 1
  done
  [ "$gone" -eq 1 ] || die "$label is still registered with launchd after bootout"
done
ok "both services gone from launchctl print"

for port in "$DAEMON_PORT" "$UI_PORT"; do
  free=0
  for _ in $(seq 1 30); do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then free=1; break; fi
    sleep 1
  done
  [ "$free" -eq 1 ] \
    || die "something is still listening on :$port — $(lsof -nP -iTCP:"$port" -sTCP:LISTEN | tail -n +2 | tr '\n' ' ')"
done
ok ":$DAEMON_PORT and :$UI_PORT are free"

others=0
for _ in $(seq 1 30); do
  others="$(q "$DB_NAME" "select count(*) from pg_stat_activity where datname='$DB_NAME' and pid <> pg_backend_pid()")"
  [ "$others" = "0" ] && break
  sleep 1
done
if [ "$others" != "0" ]; then
  printf '\n  Remaining backends on %s:\n' "$DB_NAME" >&2
  q "$DB_NAME" "select '    '||coalesce(usename,'?')||' | '||coalesce(application_name,'-')||' | '||coalesce(state,'-')||' | pid='||pid from pg_stat_activity where datname='$DB_NAME' and pid <> pg_backend_pid()" >&2
  die "$others other backend(s) still connected to '$DB_NAME'. Stop them yourself — this script will not terminate connections."
fi
ok "no other backends connected to '$DB_NAME'"

# ---------------------------------------------------------------------------
# 3. Database backup — taken AFTER the shutdown so it is a quiesced snapshot
# ---------------------------------------------------------------------------
say "3/8 Dumping the quiesced database"

mkdir -p "$(dirname "$DUMP_FILE")"
"$PG_BIN/pg_dump" -Fc -h localhost -U "$DB_OWNER" -d "$DB_NAME" -f "$DUMP_FILE" \
  || die "pg_dump failed — the branch has not been touched; restart the services and investigate"
[ -s "$DUMP_FILE" ] || die "pg_dump produced an empty file: $DUMP_FILE"
"$PG_BIN/pg_restore" -l "$DUMP_FILE" >/dev/null \
  || die "dump is not a readable archive: $DUMP_FILE"
dump_tables="$("$PG_BIN/pg_restore" -l "$DUMP_FILE" | grep -c 'TABLE DATA' || true)"
[ "${dump_tables:-0}" -gt 0 ] || die "dump contains no table data: $DUMP_FILE"
ok "dump: $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1), $dump_tables tables with data)"

# ---------------------------------------------------------------------------
# 4. Swap the branch
#
# Renaming the checked-out branch moves HEAD with it, so after the rename the
# checkout sits on the renamed old branch. Create amin_dev explicitly from the
# certified commit rather than renaming a second time.
# ---------------------------------------------------------------------------
say "4/8 Swapping amin_dev -> $OLD_BRANCH and checking out the certified tree"

git branch -m amin_dev "$OLD_BRANCH"
RENAMED=1
git checkout -b amin_dev "$CERTIFIED_SHA"

head_now="$(git rev-parse HEAD)"
[ "$head_now" = "$CERTIFIED_SHA" ] || die "HEAD is $head_now, expected $CERTIFIED_SHA"
[ "$(git rev-parse --abbrev-ref HEAD)" = "amin_dev" ] || die "not on amin_dev after checkout"
git branch --set-upstream-to="$CERTIFIED_REF" amin_dev >/dev/null 2>&1 || true
ok "amin_dev @ $CERTIFIED_SHA (previous branch kept as $OLD_BRANCH)"

# ---------------------------------------------------------------------------
# 5. Install, build, migrate
# ---------------------------------------------------------------------------
say "5/8 Installing, building and migrating"

pnpm install --frozen-lockfile || die "pnpm install --frozen-lockfile failed"
ok "dependencies installed"

pnpm exec turbo run build --filter='!@agor/docs' || die "build failed"
ok "build complete"

# The pending set must be exactly the certified one BEFORE anything is applied.
# If fork main's journal had been taken as-is, this list would be EMPTY and
# front desk would silently never be created — so "nothing pending" here is a
# failure, not a success.
status_before="$(db_status)"
pending_before="$(pending_of "$status_before" | tr '\n' ' ' | sed 's/ *$//')"
[ "$pending_before" = "$EXPECTED_PENDING" ] \
  || die "pending migrations are '$pending_before', expected exactly '$EXPECTED_PENDING'"
ok "pending set is exactly: $EXPECTED_PENDING"

DATABASE_URL="$owner_url" pnpm -w agor db migrate -y --offline-cutover \
  || die "migrations failed — drizzle applies the batch in one transaction, so the schema is unchanged"
MIGRATED=1
ok "migrations applied"

status_after="$(db_status)"
if printf '%s' "$status_after" | grep -q 'Pending migrations'; then
  die "migrations reported success but the database still has pending work"
fi
ok "no pending migrations remain"

ledger="$(q "$DB_NAME" "select count(*)||' '||max(created_at) from drizzle.__drizzle_migrations")"
[ "$ledger" = "$LEDGER_ROWS_AFTER $WATERMARK_AFTER" ] \
  || die "ledger after migrating is '$ledger', expected '$LEDGER_ROWS_AFTER $WATERMARK_AFTER'"
ok "ledger: $LEDGER_ROWS_AFTER rows, watermark $WATERMARK_AFTER"

fd="$(q "$DB_NAME" "select
  (select count(*) from information_schema.columns where table_schema='public' and table_name='branch_front_desk_sessions')
  ||' '||(select count(*) from pg_constraint where conrelid='public.branch_front_desk_sessions'::regclass and contype='f')
  ||' '||(select relrowsecurity and relforcerowsecurity from pg_class where oid='public.branch_front_desk_sessions'::regclass)
  ||' '||(select count(*) from pg_policy where polrelid='public.branch_front_desk_sessions'::regclass)")"
[ "$fd" = "12 3 true 1" ] \
  || die "branch_front_desk_sessions shape is '$fd' (cols fks forced-rls policies), expected '12 3 true 1'"
ok "branch_front_desk_sessions: 12 columns, 3 FKs, forced RLS, tenant policy"

[ "$(q "$DB_NAME" "select count(*) from pg_class where relname='profile_images' and relkind='r'")" = "1" ] \
  || die "expected exactly one profile_images table after migrating"
[ "$(q "$DB_NAME" "select count(*) from public.profile_images")" = "$PROFILE_ROWS_BEFORE" ] \
  || die "profile_images row count changed across the migration"
ok "one profile_images table, still $PROFILE_ROWS_BEFORE rows"

# ---------------------------------------------------------------------------
# 6. Grant the runtime role access to anything the migration created
#
# The live database has no default ACLs: objects are owned by $DB_OWNER and the
# runtime role holds explicit per-table grants, so a table created by this
# batch is owner-only and the daemon gets "permission denied" on first touch.
# Verified on the certified copy: after migrating, the runtime role could
# neither SELECT nor INSERT branch_front_desk_sessions.
#
# Deliberately NOT "GRANT ON ALL TABLES": mcp_servers_delete_audit is
# INSERT-only by design, and a blanket grant would widen an audit table to full
# DML. Only objects with no privilege at all are touched.
# ---------------------------------------------------------------------------
say "6/8 Granting the runtime role access to newly created objects"

"$PG_BIN/psql" -h localhost -U "$DB_OWNER" -d "$DB_NAME" -X -v ON_ERROR_STOP=1 -q <<SQL || die "grant step failed"
DO \$grant\$
DECLARE
  runtime_role CONSTANT text := '${RUNTIME_ROLE}';
  obj record; n_t int := 0; n_s int := 0; n_d int := 0;
BEGIN
  FOR obj IN
    SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p')
      AND NOT has_table_privilege(runtime_role, c.oid, 'SELECT')
      AND NOT has_table_privilege(runtime_role, c.oid, 'INSERT')
      AND NOT has_table_privilege(runtime_role, c.oid, 'UPDATE')
      AND NOT has_table_privilege(runtime_role, c.oid, 'DELETE')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO %I', obj.relname, runtime_role);
    RAISE NOTICE 'granted DML on public.%', obj.relname; n_t := n_t + 1;
  END LOOP;

  FOR obj IN SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'
  LOOP
    IF NOT has_sequence_privilege(runtime_role, obj.oid, 'USAGE') THEN
      EXECUTE format('GRANT USAGE ON SEQUENCE public.%I TO %I', obj.relname, runtime_role);
      RAISE NOTICE 'granted USAGE on sequence public.%', obj.relname; n_s := n_s + 1;
    END IF;
  END LOOP;

  -- The runtime role reads the watermark; the owner applies migrations.
  FOR obj IN SELECT c.oid, c.relname FROM pg_class c
    WHERE c.relnamespace='drizzle'::regnamespace AND c.relkind IN ('r','p')
      AND NOT has_table_privilege(runtime_role, c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE drizzle.%I TO %I', obj.relname, runtime_role);
    RAISE NOTICE 'granted SELECT on drizzle.%', obj.relname; n_d := n_d + 1;
  END LOOP;

  RAISE NOTICE 'grant step: % table(s), % sequence(s), % drizzle table(s)', n_t, n_s, n_d;
END
\$grant\$;
SQL
ok "grants applied"

ungranted="$(q "$DB_NAME" "
  select count(*) from pg_class c
  where c.relnamespace='public'::regnamespace and c.relkind in ('r','p')
    and not has_table_privilege('$RUNTIME_ROLE', c.oid, 'SELECT')
    and not has_table_privilege('$RUNTIME_ROLE', c.oid, 'INSERT')
    and not has_table_privilege('$RUNTIME_ROLE', c.oid, 'UPDATE')
    and not has_table_privilege('$RUNTIME_ROLE', c.oid, 'DELETE')")"
[ "$ungranted" = "0" ] \
  || die "$ungranted public table(s) are still unreachable by $RUNTIME_ROLE"
ok "every public table is reachable by $RUNTIME_ROLE"

fd_dml="$(q "$DB_NAME" "select has_table_privilege('$RUNTIME_ROLE','public.branch_front_desk_sessions','SELECT,INSERT,UPDATE,DELETE')")"
[ "$fd_dml" = "t" ] || die "$RUNTIME_ROLE lacks DML on branch_front_desk_sessions"
ok "$RUNTIME_ROLE has DML on branch_front_desk_sessions"

audit_select="$(q "$DB_NAME" "select has_table_privilege('$RUNTIME_ROLE','public.mcp_servers_delete_audit','SELECT')" 2>/dev/null || echo skip)"
if [ "$audit_select" = "t" ]; then
  die "mcp_servers_delete_audit gained SELECT — the grant step widened an append-only audit table"
fi
[ "$audit_select" = "skip" ] && note "mcp_servers_delete_audit not present; skipped" \
  || ok "mcp_servers_delete_audit is still INSERT-only"

# ---------------------------------------------------------------------------
# 7. Start the services — daemon first, then UI
# ---------------------------------------------------------------------------
say "7/8 Starting daemon, then UI"

CUTOVER_EPOCH="$(date +%s)"
readonly CUTOVER_EPOCH

launchctl bootstrap "gui/$(id -u)" "$DAEMON_PLIST" \
  || die "could not bootstrap $DAEMON_LABEL"

daemon_up=0
for _ in $(seq 1 120); do
  if curl -fsS "http://localhost:$DAEMON_PORT/health" >/dev/null 2>&1; then daemon_up=1; break; fi
  sleep 2
done
[ "$daemon_up" -eq 1 ] \
  || die "daemon did not become healthy on :$DAEMON_PORT within 240s (see ~/.agor/logs/launchd-daemon.log)"
ok "daemon healthy on :$DAEMON_PORT"

launchctl bootstrap "gui/$(id -u)" "$UI_PLIST" \
  || die "could not bootstrap $UI_LABEL"

ui_up=0
for _ in $(seq 1 120); do
  if curl -fsSI "http://localhost:$UI_PORT/" >/dev/null 2>&1; then ui_up=1; break; fi
  sleep 2
done
[ "$ui_up" -eq 1 ] \
  || die "UI did not answer on :$UI_PORT within 240s (see ~/.agor/logs/launchd-ui.log)"
ok "UI answering on :$UI_PORT"

# ---------------------------------------------------------------------------
# 8. Verify
# ---------------------------------------------------------------------------
say "8/8 Verifying"

health="$(curl -fsS "http://localhost:$DAEMON_PORT/health")" || die "daemon health check failed"
printf '%s' "$health" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get("status")=="ok" else 1)' \
  || die "daemon /health did not report status=ok"
ok "GET :$DAEMON_PORT/health -> status ok"

printf '%s' "$health" | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(0 if d.get("db",{}).get("ok") is True else 1)' \
  || die "daemon /health reports the database as not ok"
ok "/health reports db ok"

# /health can answer from a stale process, so assert the build identity it
# reports (setup/build-info.ts: `git rev-parse --short HEAD` at startup).
reported_sha="$(printf '%s' "$health" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("buildSha",""))')"
[ -n "$reported_sha" ] || die "/health exposed no buildSha; cannot prove the new build is running"
if [ "$reported_sha" = "dev" ]; then
  die "/health reports buildSha=dev (build-info fell back); cannot prove the new build is running"
fi
[ "$reported_sha" = "$EXPECTED_BUILD_SHA" ] \
  || die "/health reports buildSha=$reported_sha, expected $EXPECTED_BUILD_SHA — a stale daemon is still serving :$DAEMON_PORT"
ok "/health buildSha == $EXPECTED_BUILD_SHA (the certified commit is what is running)"

daemon_pid="$(lsof -nP -iTCP:$DAEMON_PORT -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
[ -n "$daemon_pid" ] || die "nothing is listening on :$DAEMON_PORT"
daemon_started="$(ps -o lstart= -p "$daemon_pid" 2>/dev/null | sed 's/^ *//')"
daemon_epoch="$(date -j -f '%a %b %d %T %Y' "$daemon_started" +%s 2>/dev/null || echo 0)"
if [ "$daemon_epoch" -gt 0 ]; then
  [ "$daemon_epoch" -ge "$((CUTOVER_EPOCH - 5))" ] \
    || die "the process on :$DAEMON_PORT started before the cutover ($daemon_started) — it is stale"
  ok "daemon process started after cutover ($daemon_started)"
else
  note "could not parse daemon start time; relying on the buildSha assertion above"
fi

curl -fsSI "http://localhost:$UI_PORT/" >/dev/null || die "UI HEAD check failed"
ok "HEAD :$UI_PORT/"

# Vite falls forward to 5174+ when 5173 is taken, which silently leaves the
# browser pointed at a stale server. Process ancestry distinguishes "our UI owns
# 5173" from "our UI fell forward".
ui_service_pid="$(launchctl print "gui/$(id -u)/$UI_LABEL" 2>/dev/null \
  | awk -F'= *' '/^\tpid = /{print $2; exit}' || true)"
[ -n "$ui_service_pid" ] || die "could not read the pid of $UI_LABEL"

owns_port() { # $1 = port -> 0 if a descendant of the UI service holds it
  local pid walk
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  [ -n "$pid" ] || return 1
  walk="$pid"
  for _ in $(seq 1 8); do
    [ "$walk" = "$ui_service_pid" ] && return 0
    walk="$(ps -o ppid= -p "$walk" 2>/dev/null | tr -d ' ')"
    [ -n "$walk" ] || return 1
    [ "$walk" = "1" ] && return 1
  done
  return 1
}

owns_port "$UI_PORT" \
  || die ":$UI_PORT is not held by $UI_LABEL — vite has fallen forward, check ~/.agor/logs/launchd-ui.log"
for extra in 5174 5175 5176 5177; do
  if owns_port "$extra"; then die "$UI_LABEL fell forward onto :$extra — it must own :$UI_PORT"; fi
done
ok "$UI_LABEL owns :$UI_PORT, no fall-forward"

[ "$(git rev-parse HEAD)" = "$CERTIFIED_SHA" ] || die "HEAD drifted from the certified SHA"
ok "HEAD still $CERTIFIED_SHA"

cat <<EOF

--------------------------------------------------------------------------
Adopted.

  amin_dev            $CERTIFIED_SHA
  /health buildSha    $EXPECTED_BUILD_SHA
  previous branch     $OLD_BRANCH (kept; delete it once you are happy)
  previous commit     $PREVIOUS_SHA ($PREVIOUS_REF)
  database dump       $DUMP_FILE
  ledger              $LEDGER_ROWS_AFTER rows, watermark $WATERMARK_AFTER
  daemon log          ~/.agor/logs/launchd-daemon.log
  ui log              ~/.agor/logs/launchd-ui.log
--------------------------------------------------------------------------
EOF
