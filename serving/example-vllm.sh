# sparkdash-serve: description=vLLM OpenAI-compatible server (model from modelctl store) defaultPort=8080
#
# sparkDash serving contract:
#   MODEL_NAME  — model selected in the UI ("" when none)
#   PORT        — port to serve on
#   EXTRA_ARGS  — ONE already shell-quoted string; expand unquoted (word-splitting intended)
#
# Resolves the model path via modelctl; falls back to the raw model name when
# the model is not registered locally (e.g. vLLM can resolve HF repo ids itself).
set -eu

MODEL_PATH="$(modelctl path "$MODEL_NAME" --local 2>/dev/null || true)"
if [ -z "$MODEL_PATH" ]; then
  MODEL_PATH="$MODEL_NAME"
fi

echo "[example-vllm] model=$MODEL_PATH port=$PORT extra=$EXTRA_ARGS"
exec vllm serve "$MODEL_PATH" --host 0.0.0.0 --port "${PORT:-8080}" $EXTRA_ARGS
