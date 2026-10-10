#!/bin/sh
# Run one dispatch through Codex and log it.
#
#   plan/codex.sh <id> [effort] [sandbox] [est_min] [max_min]
#
#   id       the dispatch's id: plan/dispatches/<id>-*.md
#   effort   model_reasoning_effort: high (default) or xhigh
#   sandbox  ro  = Codex's read-only sandbox (investigations, reviews)
#            rw  = Codex's workspace-write sandbox with loopback network, so
#                  node tests that listen on 127.0.0.1 run (default); headless
#                  Chrome does not start inside it, so the browser check is the
#                  lead's unless D0f found flags that work
#   est_min  the plan's estimate, written to the log row (default blank)
#   max_min  watchdog: Codex is killed after this many minutes (default 90)
#
# Writes plan/logs/<id>.jsonl (events), plan/logs/<id>.err (stderr),
# plan/evidence/<id>-last.md (Codex's final message), and appends one row to
# plan/log.tsv with the model, effort, minutes, and token counts.
# Prints a four-line summary; the lead reads that and the return file, never the log.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID=${1:?usage: plan/codex.sh <id> [effort] [ro|rw] [est_min] [max_min]}
EFFORT=${2:-high}
MODE=${3:-rw}
EST=${4:-}
MAX_MIN=${5:-90}
DISPATCH=$(ls "$ROOT"/plan/dispatches/"$ID"-*.md 2>/dev/null | head -1)
if [ -z "$DISPATCH" ]; then echo "no dispatch plan/dispatches/$ID-*.md" >&2; exit 2; fi
case "$MODE" in
  ro) SANDBOX_ARGS="--sandbox read-only" ;;
  rw) SANDBOX_ARGS="--sandbox workspace-write -c sandbox_workspace_write.network_access=true" ;;
  *) echo "mode must be ro or rw" >&2; exit 2 ;;
esac
mkdir -p "$ROOT/plan/logs" "$ROOT/plan/evidence"
MODEL=$(sed -n 's/^model *= *"\(.*\)"/\1/p' "$HOME/.codex/config.toml" | head -1)
LOG="$ROOT/plan/logs/$ID.jsonl"
ERR="$ROOT/plan/logs/$ID.err"
LAST="$ROOT/plan/evidence/$ID-last.md"
START=$(date "+%Y-%m-%dT%H:%M")
START_S=$(date +%s)

# shellcheck disable=SC2086
codex exec $SANDBOX_ARGS -C "$ROOT" -c "model_reasoning_effort=\"$EFFORT\"" --json \
  -o "$LAST" - < "$DISPATCH" > "$LOG" 2> "$ERR" &
PID=$!
RESULT=""
while kill -0 "$PID" 2>/dev/null; do
  sleep 20
  if [ $(( $(date +%s) - START_S )) -gt $(( MAX_MIN * 60 )) ]; then
    kill "$PID" 2>/dev/null
    RESULT="killed-at-${MAX_MIN}m"
  fi
done
wait "$PID"; STATUS=$?
[ -n "$RESULT" ] || RESULT="exit-$STATUS"
END=$(date "+%Y-%m-%dT%H:%M")
MIN=$(( ( $(date +%s) - START_S + 30 ) / 60 ))

USAGE=$(node -e '
  const fs = require("fs");
  let u = null;
  for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line); if (e.usage) u = e.usage; } catch {}
  }
  const n = (k) => (u && u[k] != null) ? String(u[k]) : "";
  process.stdout.write([n("input_tokens"), n("cached_input_tokens"), n("output_tokens")].join("\t"));
' "$LOG")

THREAD=$(sed -n 's/.*"type":"thread.started","thread_id":"\([^"]*\)".*/\1/p' "$LOG" | head -1)
[ -z "$THREAD" ] || printf '%s\n' "$THREAD" > "$ROOT/plan/logs/$ID.thread"

printf '%s\tdispatch\t%s\t%s\tcodex\t%s\t%s\t%s\t%s\t%s\t\t%s\t\n' \
  "$ID" "$START" "$END" "$MODEL" "$EFFORT" "$EST" "$MIN" "$USAGE" "$RESULT" >> "$ROOT/plan/log.tsv"

echo "$ID: $RESULT in ${MIN} min ($MODEL, $EFFORT, $MODE, thread ${THREAD:-?})"
echo "tokens in/cached/out: $(printf '%s' "$USAGE" | tr '\t' '/')"
echo "last message: $LAST ($(wc -l < "$LAST" 2>/dev/null | tr -d ' ') lines)"
echo "stderr: $(wc -c < "$ERR" | tr -d ' ') bytes in plan/logs/$ID.err"
