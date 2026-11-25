// React Flight ("text/x-component"), the format Next.js answers a server
// action in: rows of JSON that refer to each other, and long strings in rows
// of their own. Only as much as the Humble Bundle client reads (humble.ts):
// data, not components. Follows React's ReactFlightClient
// (processBinaryChunk and parseModelString); what it would turn into
// elements, modules, streams or other objects that data never holds reads as
// undefined here.
//
// A row is `<hex id>:<payload>`:
// - JSON up to the newline: `1:{"results":[…]}`;
// - a tag and the rest of the line: `2:I[…]` (a module), `3:HL[…]` (a hint),
//   `4:E{…}` (an error the server threw);
// - a tag, a hex byte length and a comma, then that many bytes and no
//   newline: `5:T1a,<26 bytes of text>` (a long string), or binary data.
//
// In the JSON, a string that starts with "$" is a reference or a special
// value: "$$…" is the string "$…", "$@5" and "$5" are row 5's value,
// "$5:a:0" is row 5's value at a.0, "$undefined" is undefined, and so on.

// Rows whose tag is followed by a byte length instead of a newline: text,
// and the binary types (typed arrays, ArrayBuffer, DataView).
const LENGTH_TAGS = "TAOobUSsLlGgMmV";

// Nested deeper than this is no answer of a server, but a loop.
const MAX_DEPTH = 256;

export type FlightRow =
  | { kind: "json"; value: unknown }
  | { kind: "text"; value: string }
  // An error the server threw (`E` row): its message, or only its digest in
  // production.
  | { kind: "error"; message: string }
  // Anything else (modules, hints, binary data, debug rows): skipped.
  | { kind: "other"; tag: string };

// A Flight answer that can't be read.
export class FlightFormatError extends Error {
  name = "FlightFormatError";
}

// The rows of a Flight answer, by id. Throws FlightFormatError on text that
// isn't one.
export function parseFlightRows(body: string): Map<number, FlightRow> {
  // (lengths count UTF-8 bytes)
  const bytes = Buffer.from(body, "utf8");
  const rows = new Map<number, FlightRow>();
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] === 0x0a || bytes[i] === 0x0d) {
      i += 1;
      continue;
    }
    const colon = bytes.indexOf(0x3a, i);
    const idText = colon < 0 ? "" : bytes.toString("latin1", i, colon);
    if (!/^[0-9a-f]{1,8}$/.test(idText)) {
      throw new FlightFormatError(
        `a row without an id at byte ${i}: ${JSON.stringify(bytes.toString("utf8", i, i + 40))}`,
      );
    }
    const id = parseInt(idText, 16);
    const start = colon + 1;
    const tag = String.fromCharCode(bytes[start] ?? 0);
    if (LENGTH_TAGS.includes(tag)) {
      const comma = bytes.indexOf(0x2c, start + 1);
      const lengthText =
        comma < 0 ? "" : bytes.toString("latin1", start + 1, comma);
      if (!/^[0-9a-f]{1,8}$/.test(lengthText)) {
        throw new FlightFormatError(`row ${idText} has no length`);
      }
      const end = comma + 1 + parseInt(lengthText, 16);
      if (end > bytes.length) {
        throw new FlightFormatError(`row ${idText} is cut off`);
      }
      rows.set(
        id,
        tag === "T"
          ? { kind: "text", value: bytes.toString("utf8", comma + 1, end) }
          : { kind: "other", tag },
      );
      i = end;
      continue;
    }
    let lineEnd = bytes.indexOf(0x0a, start);
    if (lineEnd < 0) {
      lineEnd = bytes.length;
    }
    const line = bytes.toString("utf8", start, lineEnd).replace(/\r$/, "");
    i = lineEnd + 1;
    if (/^[A-Z#rx]/.test(line)) {
      // (React's tags: an uppercase letter, "#", "r" or "x"; JSON starts
      // with none of them)
      const tagged = line[0];
      rows.set(
        id,
        tagged === "E"
          ? { kind: "error", message: errorMessage(line.slice(1)) }
          : { kind: "other", tag: tagged },
      );
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (err) {
      throw new FlightFormatError(
        `row ${idText} is not JSON: ${(err as Error).message}`,
      );
    }
    rows.set(id, { kind: "json", value });
  }
  return rows;
}

function errorMessage(json: string): string {
  try {
    const error = JSON.parse(json);
    const message = typeof error?.message === "string" ? error.message : "";
    const digest = typeof error?.digest === "string" ? error.digest : "";
    return message || (digest ? `error ${digest}` : "an error");
  } catch {
    return "an error";
  }
}

// The value of row `id`, its references resolved. A reference to an error
// row throws that error; a reference to a row that isn't there is a
// FlightFormatError (a cut-off answer).
export function flightValue(rows: Map<number, FlightRow>, id: number): unknown {
  return new Resolver(rows).row(id, 0);
}

// The value of the whole answer: row 0.
export function flightRoot(body: string): unknown {
  return flightValue(parseFlightRows(body), 0);
}

// Field `key` of row `id` (an object), its references resolved; undefined
// when the row is no object. The row's other fields are left as they are:
// Next.js's action answer also carries the page, rendered again, in `f`
// when the action revalidates, and a part that isn't read can't fail the
// answer (an error of some component in it, or a page nested too deep).
export function flightField(
  rows: Map<number, FlightRow>,
  id: number,
  key: string,
): unknown {
  return new Resolver(rows).field(id, key);
}

// The server threw while it made the answer.
export class FlightServerError extends Error {
  name = "FlightServerError";
}

class Resolver {
  // Rows already resolved, and those being resolved (a loop reads as
  // undefined rather than going round forever).
  private done = new Map<number, unknown>();
  private busy = new Set<number>();

  constructor(private rows: Map<number, FlightRow>) {}

  field(id: number, key: string): unknown {
    const row = this.rows.get(id);
    if (!row) {
      throw new FlightFormatError(`row ${id.toString(16)} is missing`);
    }
    if (row.kind === "error") {
      throw new FlightServerError(`the server failed: ${row.message}`);
    }
    if (
      row.kind !== "json" ||
      row.value === null ||
      typeof row.value !== "object" ||
      Array.isArray(row.value)
    ) {
      return undefined;
    }
    // (a bare reference to the row itself, inside the field, must not
    // resolve the whole row, the parts that aren't read included)
    this.busy.add(id);
    try {
      return this.value((row.value as Record<string, unknown>)[key], 2);
    } finally {
      this.busy.delete(id);
    }
  }

  row(id: number, depth: number): unknown {
    if (this.done.has(id)) {
      return this.done.get(id);
    }
    if (this.busy.has(id)) {
      return undefined;
    }
    const row = this.rows.get(id);
    if (!row) {
      throw new FlightFormatError(
        `row ${id.toString(16)} is referred to but missing`,
      );
    }
    if (row.kind === "error") {
      throw new FlightServerError(`the server failed: ${row.message}`);
    }
    this.busy.add(id);
    const value =
      row.kind === "json"
        ? this.value(row.value, depth + 1)
        : row.kind === "text"
          ? row.value
          : undefined;
    this.busy.delete(id);
    this.done.set(id, value);
    return value;
  }

  value(value: unknown, depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new FlightFormatError("the answer is nested too deep");
    }
    if (typeof value === "string") {
      return value.startsWith("$") ? this.special(value, depth) : value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.value(v, depth + 1));
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        out[key] = this.value(v, depth + 1);
      }
      return out;
    }
    return value;
  }

  // parseModelString: a string that starts with "$".
  private special(text: string, depth: number): unknown {
    const kind = text[1];
    switch (kind) {
      case "$":
        return text.slice(1);
      case "@":
      case "L": {
        // (a promise, or a lazy element: the row's value either way)
        const id = text.slice(2);
        return /^[0-9a-f]+$/.test(id)
          ? this.row(parseInt(id, 16), depth)
          : undefined;
      }
      case "u":
        return undefined; // $undefined
      case "N":
        return NaN;
      case "I":
        return Infinity;
      case "-":
        return text === "$-0" ? -0 : -Infinity;
      case "D":
      case "n":
        // A date or a BigInt: its text is all the data needs.
        return text.slice(2);
      default:
        return this.reference(text.slice(1), depth);
    }
  }

  // "$5" or "$5:path:to:value": a row's value, or a part of it.
  private reference(ref: string, depth: number): unknown {
    const [idText, ...path] = ref.split(":");
    if (!/^[0-9a-f]+$/.test(idText)) {
      // (a symbol, a module, a Map, a stream: nothing data holds)
      return undefined;
    }
    const id = parseInt(idText, 16);
    if (path.length === 0) {
      return this.row(id, depth);
    }
    // A part of a row. React writes an object it wrote before as a
    // reference to where it first was, also inside the row being read: the
    // part is looked up in the row as sent, and only then resolved.
    const row = this.rows.get(id);
    if (!row) {
      throw new FlightFormatError(`row ${idText} is referred to but missing`);
    }
    if (row.kind === "error") {
      throw new FlightServerError(`the server failed: ${row.message}`);
    }
    if (row.kind !== "json") {
      return undefined;
    }
    let value: unknown = row.value;
    let resolved = false;
    for (const key of path) {
      if (!resolved && typeof value === "string" && value.startsWith("$")) {
        value = this.special(value, depth + 1);
        resolved = true;
      }
      if (value === null || typeof value !== "object") {
        return undefined;
      }
      value = (value as Record<string, unknown>)[key];
    }
    return resolved ? value : this.value(value, depth + 1);
  }
}
