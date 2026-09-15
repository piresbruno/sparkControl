# Proposal (upstream, NOT FILED) — `recipe.json` sidecar for recipe folders

Target: the recipe folders in the MiaAI-Lab repos (e.g. the GLM-5.3 vLLM recipe — the folders
sparkControl's Serve section registers). This is a draft; file as an issue only after user review.

## Problem we work around today

sparkControl probes each recipe folder over SSH to *infer* its interface:

| Inference | How | Failure mode |
|---|---|---|
| Entry variant | `find -maxdepth 2 -name '*.sh'`, dispatch verbs per file | ambiguous with multiple `start*.sh` that are all real |
| Port | `PORT=` in `.env.example`/`.env` (`.env` wins — recipes source it second) | scripts that take `--port` only → PORT-probe fallback |
| Topology | `NNODES` else `WORKER_IP` ⇒ 2, else 1 | tp4-without-NNODES variants need the exact-delta refusal dialog |
| Container set | `grep -H 'CONTAINER[A-Z_]*=' start.sh start-*.sh tp*/start*.sh` | naming conventions outside the regex are invisible |
| Model identity | `MODEL=` / `SERVED_MODEL_NAME=` in env files | comments-only defaults in start.sh are missed |
| Dispatch verbs | `grep -oE '^ *(start|stop|status|logs|restart)\)'` | only the exact `verb)` line form matches |

Every row is heuristic; a declared sidecar deletes the heuristics (and our parser's bug surface).

## Proposal

`recipe.json` at the folder root (next to `start.sh`), all fields optional, additive:

```json
{
  "name": "glm-5.3-vllm",
  "model": "org/GLM-5.3",
  "servedName": "glm-5.3",
  "entry": "start.sh",
  "variants": [ { "path": "start-tp4.sh", "label": "TP4" } ],
  "port": 8081,
  "env": { "PUBLIC": ["PORT", "MODEL", "NNODES", "MAX_MODEL_LEN"], "SECRET": ["VLLM_API_KEY"] },
  "topology": { "nnodes": 2, "workerFrom": "WORKER_IP" },
  "containers": { "start.sh": ["glm-vllm"], "start-tp4.sh": ["glm-vllm-head", "glm-vllm-tp"] },
  "verbs": ["start", "stop", "status", "logs", "restart"],
  "readyTimeoutS": 1800
}
```

Rules we'd honor: the file **describes, never configures** — `start.sh` remains the single source of
runtime behavior; absence ⇒ today's probing unchanged (zero adoption dependency); unknown keys ignored;
`.env` values still win over declared defaults at run time. `public/secret` env split replaces our
`/(KEY|TOKEN|SECRET|PASSWORD)$/i` guess so secret handling is explicit, not inferred.

Nothing in sparkControl needs this to work — it lets us drop ~120 lines of grep heuristics and the
`dispatchOk`-class probe failures. Happy to send a PR against one reference recipe if useful.

## Adoption note for our side

`parseRecipeProbe` (server/serving/recipes.js) would read the sidecar via the existing probe command
(one more `cat recipe.json` section), fall back to scraping on absent/invalid JSON. UI chips gain a
`declared` vs `inferred` badge so users can see which folders adopted it.
