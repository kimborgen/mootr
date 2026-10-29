// Field values as one compact line, `key=value` pairs; empty when the ITSA holds none. A cleared
// or unset value (null) shows as (none), so a change line reads `stage=plan -> stage=(none)`.
export function fieldsLine(f: Record<string, unknown> | undefined): string {
  const e = Object.entries(f ?? {});
  return e.map(([k, v]) => `${k}=${v === null || v === undefined ? '(none)' : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
}

// The change line for an ITSA's fields, from the daemon's {from, to} maps: `fields: stage=plan -> stage=code`.
// The MCP tool and the CLI both print it, so a fields change reads the same in each (S-2786).
export function fieldsChange(c: { from: unknown; to: unknown }): string {
  return `fields: ${fieldsLine(c.from as Record<string, unknown>)} -> ${fieldsLine(c.to as Record<string, unknown>)}`;
}
