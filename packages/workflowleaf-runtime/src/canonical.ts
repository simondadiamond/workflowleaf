/**
 * Deterministic serialization.
 *
 * Gate definitions and run plans are hashed, so their text has to be a function
 * of their content alone. Object key order in JavaScript is insertion order,
 * which means the same gate written twice can serialize two ways and produce
 * two digests. Sorting keys here removes that.
 *
 * The same writer also renders the human-facing output, so what a reader sees
 * and what the run hashed are the same bytes.
 */

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function quote(value: string): string {
  let out = '"';
  for (const character of value) {
    const escape = ESCAPES[character];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = character.codePointAt(0)!;
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return `${out}"`;
}

function write(value: unknown, indent: number, depth: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return quote(value);

  const pad = indent === 0 ? "" : "\n" + " ".repeat(indent * (depth + 1));
  const closePad = indent === 0 ? "" : "\n" + " ".repeat(indent * depth);
  const separator = indent === 0 ? "," : `,${pad}`;

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => write(item, indent, depth + 1));
    return `[${pad}${items.join(separator)}${closePad}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    if (keys.length === 0) return "{}";
    const entries = keys.map(
      (key) => `${quote(key)}:${indent === 0 ? "" : " "}${write(record[key], indent, depth + 1)}`,
    );
    return `{${pad}${entries.join(separator)}${closePad}}`;
  }

  return "null";
}

/** Compact, key-sorted. This is what gets hashed. */
export function canonicalJson(value: unknown): string {
  return write(value, 0, 0);
}

/** Key-sorted and indented. This is what gets printed. */
export function prettyJson(value: unknown, indent = 2): string {
  return write(value, indent, 0);
}

export type { Json };
