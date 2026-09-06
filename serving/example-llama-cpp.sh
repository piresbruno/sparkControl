# sparkdash-serve: description=llama.cpp server (GGUF from modelctl store) defaultPort=8081
#
# sparkDash serving contract:
#   MODEL_NAME  — model selected in the UI ("" when none)
#   PORT        — port to serve on
#   EXTRA_ARGS  — ONE already shell-quoted string; expand unquoted (word-splitting intended)
#
# GGUF-only: aborts with a clear message when the model is not synced/pushed
# to this node (modelctl path --local resolves empty).
set -eu

MODEL_PATH="$(modelctl path "$MODEL_NAME" --local 2>/dev/null || true)"
if [ -z "$MODEL_PATH" ]; then
  echo "[example-llama-cpp] ERROR: model '$MODEL_NAME' is not available on this node." >&2
  echo "Sync it from the NAS (sync-local) or push it from a peer node first." >&2
  exit 2
fi

echo "[example-llama-cpp] model=$MODEL_PATH port=$PORT extra=$EXTRA_ARGS"
exec llama-server -m "$MODEL_PATH" --host 0.0.0.0 --port "${PORT:-8081}" $EXTRA_ARGS
