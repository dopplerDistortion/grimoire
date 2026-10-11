#!/usr/bin/env bash
# Spike E (GOK-130) harness, for Git Bash on Windows (it uses cygpath).
#
#   SPIKE_DIR=<scratch folder> run.sh <run-name> <prompt> [extra-config.toml] [-- extra codex exec args...]
#
# Each run gets a throwaway CODEX_HOME (never ~/.codex) under
# $SPIKE_DIR/runs/<run-name>/home, whose config.toml points Codex at the
# scripted Responses API stand-in (fake-responses.mjs) and declares spike B's
# probe as MCP server `probe`, with its wire captured in .../cap/. The workdir is
# a fresh git repo unless WORK=<dir> names one; it is trusted as a project.
#
# Env: WORK=<dir> reuses a workdir. KEEP_HOME=1 keeps the run's CODEX_HOME
# (its config.toml, so trust written by hooks-rpc.mjs survives; only the
# stand-in's port is updated). DRIVER=appserver runs the prompt through
# appserver-turn.mjs (HISTORY=legacy|paginated; prompts split on a line
# '---TURN---' run as turns of one thread) instead of `codex exec`.
# Extra config files may use @KIT@ (this folder), @WORK@ and @R@ (the run dir).
set -u
KIT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$KIT/../../.." && pwd)
K=${SPIKE_DIR:?set SPIKE_DIR to a scratch folder}
NAME=$1; PROMPT=$2; EXTRA=${3:-}
shift 3 2>/dev/null || shift $#
[ "${1:-}" = "--" ] && shift
R=$K/runs/$NAME
if [ -z "${KEEP_HOME:-}" ]; then rm -rf "$R"; fi
mkdir -p "$R/home" "$R/fake" "$R/cap"
if [ ! -f "$K/probe.mjs" ]; then
  node --input-type=module -e "import('$(cygpath -m "$REPO")/test/spikes/mcp-dual-era/bundle-probe.mjs').then((m) => m.bundleProbe('$(cygpath -m "$K")'))"
fi
W=${WORK:-$R/work}
if [ ! -d "$W/.git" ] && [ ! -f "$W/.git" ]; then
  mkdir -p "$W" && (cd "$W" && git init -q . && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init)
fi
rm -f "$R/fake/port"
node "$KIT/fake-responses.mjs" "$(cygpath -w "$R/fake")" &
FAKE=$!
for _ in $(seq 1 50); do [ -f "$R/fake/port" ] && break; sleep 0.1; done
PORT=$(cat "$R/fake/port")
WW=$(cygpath -m "$W"); CAPW=$(cygpath -m "$R/cap"); PROBEW=$(cygpath -m "$K/probe.mjs")
if [ -n "${KEEP_HOME:-}" ] && [ -f "$R/home/config.toml" ]; then
  sed -i "s#^base_url = \"http://127.0.0.1:[0-9]*/v1\"#base_url = \"http://127.0.0.1:$PORT/v1\"#" "$R/home/config.toml"
else
{
  echo 'model = "gpt-5.5"'
  echo 'model_provider = "fake"'
  echo
  if [ -n "$EXTRA" ]; then sed -e "s#@WORK@#$WW#g" -e "s#@KIT@#$(cygpath -m "$KIT")#g" -e "s#@R@#$(cygpath -m "$R")#g" "$EXTRA"; echo; fi
  echo '[model_providers.fake]'
  echo 'name = "fake"'
  echo "base_url = \"http://127.0.0.1:$PORT/v1\""
  echo 'wire_api = "responses"'
  echo
  echo "[projects.'$(cygpath -w "$W")']"
  echo 'trust_level = "trusted"'
  echo
  echo '[mcp_servers.probe]'
  echo 'command = "node"'
  echo "args = [\"$PROBEW\"]"
  echo "env = { GRIMOIRE_PROBE_CAPTURE_DIR = \"$CAPW\" }"
} > "$R/home/config.toml"
fi
if [ "${DRIVER:-exec}" = "appserver" ]; then
  (cd "$W" && timeout 180 node "$(cygpath -w "$KIT/appserver-turn.mjs")" "$(cygpath -w "$R/home")" "$(cygpath -w "$W")" "${HISTORY:-legacy}" "$PROMPT" < /dev/null > "$R/exec.out" 2> "$R/exec.err")
else
  (cd "$W" && CODEX_HOME=$(cygpath -w "$R/home") timeout 180 codex exec --skip-git-repo-check "$@" "$PROMPT" < /dev/null > "$R/exec.out" 2> "$R/exec.err")
fi
echo "exit=$?"
kill $FAKE 2>/dev/null
echo "--- stdout"; tail -15 "$R/exec.out"
echo "--- stderr (filtered)"; grep -v "PATH aliases\|^Reading additional" "$R/exec.err" | tail -25
