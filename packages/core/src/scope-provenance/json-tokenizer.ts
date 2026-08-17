/**
 * Validating JSON tokenizer for scope-provenance intent parse (#3385 F3 / E9).
 *
 * JSON.parse collapses duplicate object keys; a reviver never sees them.
 * This scanner rejects duplicate keys (including nested) and does not treat
 * JSON-looking text inside string values as structure.
 */

export interface JsonParseOk {
  readonly ok: true;
  readonly value: unknown;
}

export interface JsonParseErr {
  readonly ok: false;
  readonly error: string;
}

export type JsonParseResult = JsonParseOk | JsonParseErr;

class Scanner {
  private i = 0;
  constructor(private readonly s: string) {}

  parseDocument(): unknown {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.i < this.s.length) {
      throw new Error(`trailing content at ${this.i}`);
    }
    return value;
  }

  private peek(): string {
    return this.s[this.i] ?? "";
  }

  private next(): string {
    const ch = this.s[this.i] ?? "";
    this.i += 1;
    return ch;
  }

  private skipWs(): void {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i += 1;
        continue;
      }
      break;
    }
  }

  private parseValue(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === '"') return this.parseString();
    if (c === "{") return this.parseObject();
    if (c === "[") return this.parseArray();
    if (c === "t" || c === "f") return this.parseLiteralBool();
    if (c === "n") return this.parseNull();
    if (c === "-" || (c >= "0" && c <= "9")) return this.parseNumber();
    throw new Error(`unexpected token at ${this.i}`);
  }

  private parseObject(): Record<string, unknown> {
    this.next(); // {
    this.skipWs();
    const out: Record<string, unknown> = {};
    const seen = new Set<string>();
    if (this.peek() === "}") {
      this.next();
      return out;
    }
    while (true) {
      this.skipWs();
      if (this.peek() !== '"') {
        throw new Error(`expected object key at ${this.i}`);
      }
      const key = this.parseString();
      if (seen.has(key)) {
        throw new Error(`duplicate key ${JSON.stringify(key)}`);
      }
      seen.add(key);
      this.skipWs();
      if (this.next() !== ":") {
        throw new Error(`expected ':' after key at ${this.i}`);
      }
      out[key] = this.parseValue();
      this.skipWs();
      const sep = this.next();
      if (sep === "}") return out;
      if (sep !== ",") {
        throw new Error(`expected ',' or '}' at ${this.i}`);
      }
    }
  }

  private parseArray(): unknown[] {
    this.next(); // [
    this.skipWs();
    const out: unknown[] = [];
    if (this.peek() === "]") {
      this.next();
      return out;
    }
    while (true) {
      out.push(this.parseValue());
      this.skipWs();
      const sep = this.next();
      if (sep === "]") return out;
      if (sep !== ",") {
        throw new Error(`expected ',' or ']' at ${this.i}`);
      }
    }
  }

  private parseString(): string {
    this.next(); // "
    let out = "";
    while (this.i < this.s.length) {
      const c = this.next();
      if (c === '"') return out;
      if (c === "\\") {
        out += this.parseEscape();
        continue;
      }
      if (c.charCodeAt(0) < 0x20) {
        throw new Error(`unescaped control in string at ${this.i}`);
      }
      out += c;
    }
    throw new Error("unterminated string");
  }

  private parseEscape(): string {
    const c = this.next();
    switch (c) {
      case '"':
      case "\\":
      case "/":
        return c;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          throw new Error(`invalid unicode escape at ${this.i}`);
        }
        this.i += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      default:
        throw new Error(`invalid escape at ${this.i}`);
    }
  }

  private parseNumber(): number {
    const start = this.i;
    if (this.peek() === "-") this.next();
    if (this.peek() === "0") {
      this.next();
    } else {
      if (this.peek() < "1" || this.peek() > "9") {
        throw new Error(`invalid number at ${start}`);
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    }
    if (this.peek() === ".") {
      this.next();
      if (this.peek() < "0" || this.peek() > "9") {
        throw new Error(`invalid fraction at ${this.i}`);
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    }
    if (this.peek() === "e" || this.peek() === "E") {
      this.next();
      if (this.peek() === "+" || this.peek() === "-") this.next();
      if (this.peek() < "0" || this.peek() > "9") {
        throw new Error(`invalid exponent at ${this.i}`);
      }
      while (this.peek() >= "0" && this.peek() <= "9") this.next();
    }
    const n = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(n)) {
      throw new Error(`invalid number at ${start}`);
    }
    return n;
  }

  private parseLiteralBool(): boolean {
    if (this.s.startsWith("true", this.i)) {
      this.i += 4;
      return true;
    }
    if (this.s.startsWith("false", this.i)) {
      this.i += 5;
      return false;
    }
    throw new Error(`invalid literal at ${this.i}`);
  }

  private parseNull(): null {
    if (this.s.startsWith("null", this.i)) {
      this.i += 4;
      return null;
    }
    throw new Error(`invalid literal at ${this.i}`);
  }
}

/** Parse JSON and reject duplicate object keys (nested included). */
export function parseJsonRejectingDuplicateKeys(text: string): JsonParseResult {
  try {
    const value = new Scanner(text).parseDocument();
    return { ok: true, value };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
