// Defense-in-depth: scrub known secret values from anything we persist or log.
// Secrets should never reach these strings in the first place (scrubbed env,
// generic errors) — this catches the mistake we didn't foresee.
export function makeRedactor(secrets) {
  const needles = (secrets || []).filter((s) => typeof s === 'string' && s.length >= 8);
  return function redact(input) {
    if (input == null) return input;
    if (typeof input === 'string') {
      let out = input;
      for (const n of needles) out = out.split(n).join('[REDACTED]');
      return out;
    }
    if (Array.isArray(input)) return input.map((v) => redact(v));
    if (typeof input === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(input)) out[k] = redact(v);
      return out;
    }
    return input;
  };
}
