/**
 * Shell quoting for remote script transport.
 *
 * Rules (see plan B2):
 *  - Values matching /^[A-Za-z0-9._~\/:@+-]+$/ pass through unquoted.
 *  - Everything else is wrapped in single quotes with '\'' escaping.
 *
 * `~` is included beyond the plan charset: remoteBin values like
 * `~/.local/bin/modelctl` flow through shellQuote, and single-quoting would
 * break tilde expansion. Unquoted `~` is injection-safe (the shell expands it
 * only at the start of a word).
 *
 * Callers must still apply domain validation at the REST layer (e.g. model
 * names additionally validated against /^[a-zA-Z0-9._-]+$/); shellQuote is the
 * transport-level defense for values that legitimately contain odd characters
 * (HF repo ids with `/`, free-text args, etc.).
 */

const SAFE = /^[A-Za-z0-9._~\/:@+-]+$/;

export function shellQuote(value) {
  const s = String(value);
  if (SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
