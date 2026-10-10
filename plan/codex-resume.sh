#!/bin/sh
# Continue a dispatch's Codex session with new information: a failing browser
# scenario, a screenshot, a review finding. The session keeps its context, so
# this is far cheaper than a fresh dispatch.
#
#   RESUME_MAX_MIN=60 plan/codex-resume.sh <id> <message-file> [image.png ...]
#
# Appends to plan/logs/<id>.jsonl, overwrites plan/evidence/<id>-last.md with
# the new final message, and appends a "resume" row to plan/log.tsv.
# The message file must end with a stop condition, like a dispatch.
# RESUME_MAX_MIN (default 60) is the watchdog in minutes.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID=${1:?usage: plan/codex-resume.sh <id> <message-file> [image ...]}
MSG=${2:?usage: plan/codex-resume.sh <id> <message-file> [image ...]}
MAX_MIN=${RESUME_MAX_MIN:-60}
shift 2
THREAD=$(cat "$ROOT/plan/logs/$ID.thread" 2>/dev/null)
if [ -z "$THREAD" ]; then echo "no thread id for $ID (plan/logs/$ID.thread)" >&2; exit 2; fi
IMAGES=""
for img in "$@"; do IMAGES="$IMAGES -i $img"; done
LOG="$ROOT/plan/logs/$ID.jsonl"
LAST="$ROOT/plan/evidence/$ID-last.md"
START=$(date "+%Y-%m-%dT%H:%M")
START_S=$(date +%s)
# shellcheck disable=SC2086
codex exec --sandbox workspace-write -c sandbox_workspace_write.network_access=true --json -o "$LAST" \
  resume $IMAGES "$THREAD" - < "$MSG" >> "$LOG" 2>> "$ROOT/plan/logs/$ID.err" &
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
MIN=$(( ( $(date +%s) - START_S + 30 ) / 60 ))
printf '%s\tresume\t%s\t%s\tcodex\t\t\t\t%s\t\t\t\t\t%s\t%s\n' \
  "$ID" "$START" "$(date "+%Y-%m-%dT%H:%M")" "$MIN" "$RESULT" "$(basename "$MSG")" >> "$ROOT/plan/log.tsv"
echo "$ID resume: $RESULT in ${MIN} min; last message: $LAST ($(wc -l < "$LAST" 2>/dev/null | tr -d ' ') lines)"
