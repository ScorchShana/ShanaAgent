import type { JsonObject } from "@earendil-works/pi-ai";

export type ArgumentParse =
  | { status: "parsed"; arguments: JsonObject }
  | {
      status: "invalid";
      error: "syntax" | "incomplete" | "duplicate_key" | "not_object" | "non_finite_number";
    };

export function hasNonFiniteNumber(value: unknown): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).some(hasNonFiniteNumber);
}

export function parseArguments(raw: string, allowRepair: boolean): ArgumentParse {
  let pos = 0;
  const error = (kind: "syntax" | "incomplete" | "duplicate_key"): never => {
    throw kind;
  };
  const space = () => {
    while (/[\t\n\r ]/.test(raw[pos] ?? "!")) pos++;
  };
  const required = () => {
    space();
    if (pos === raw.length) error("incomplete");
  };
  const string = (): string => {
    const start = pos++;
    let encoded = '"';
    while (pos < raw.length) {
      const char = raw[pos++]!;
      if (char === '"') return encoded + '"';
      if (char === "\\") {
        if (pos === raw.length) error("incomplete");
        const escape = raw[pos++]!;
        if (escape === "u") {
          const digits = raw.slice(pos, pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            if (digits.length < 4 && /^[0-9a-fA-F]*$/.test(digits)) error("incomplete");
            error("syntax");
          }
          encoded += "\\u" + digits;
          pos += 4;
        } else {
          if (!'"\\/bfnrt'.includes(escape)) error("syntax");
          encoded += "\\" + escape;
        }
      } else if (char.charCodeAt(0) < 32) {
        if (!allowRepair) error("syntax");
        encoded += JSON.stringify(char).slice(1, -1);
      } else encoded += char;
    }
    if (pos > start) error("incomplete");
    return error("syntax");
  };
  const value = (): string => {
    required();
    const char = raw[pos];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      const object = char === "{";
      const close = object ? "}" : "]";
      pos++;
      required();
      const items: string[] = [];
      const keys = new Set<string>();
      if (raw[pos] === close) {
        pos++;
        return char + close;
      }
      for (;;) {
        required();
        let item = "";
        if (object) {
          if (raw[pos] !== '"') error("syntax");
          const key = string();
          const decoded = JSON.parse(key) as string;
          if (keys.has(decoded)) error("duplicate_key");
          keys.add(decoded);
          required();
          if (raw[pos++]! !== ":") error("syntax");
          item = key + ":";
        }
        items.push(item + value());
        required();
        if (raw[pos] === close) {
          pos++;
          break;
        }
        if (raw[pos++]! !== ",") error("syntax");
        required();
        if (raw[pos] === close) {
          if (!allowRepair) error("syntax");
          pos++;
          break;
        }
      }
      return char + items.join(",") + close;
    }
    for (const literal of ["true", "false", "null"]) {
      if (raw.startsWith(literal, pos)) {
        pos += literal.length;
        return literal;
      }
      if (literal.startsWith(raw.slice(pos))) error("incomplete");
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(pos));
    if (!match) {
      if (raw.slice(pos) === "-") error("incomplete");
      return error("syntax");
    }
    pos += match[0].length;
    if (/^[.eE][+-]?$/.test(raw.slice(pos))) error("incomplete");
    return match[0];
  };
  if (!raw.trim()) return { status: "invalid", error: "syntax" };
  try {
    const encoded = value();
    space();
    if (pos !== raw.length) error("syntax");
    const parsed: unknown = JSON.parse(encoded);
    if (hasNonFiniteNumber(parsed)) return { status: "invalid", error: "non_finite_number" };
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return { status: "invalid", error: "not_object" };
    return { status: "parsed", arguments: parsed as JsonObject };
  } catch (cause) {
    return {
      status: "invalid",
      error: cause === "incomplete" || cause === "duplicate_key" ? cause : "syntax",
    };
  }
}
