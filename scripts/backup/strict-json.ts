/**
 * G-Backup-A Phase-10 hardening — a strict, recursive-descent JSON parser for ACTIVE governance files.
 *
 * Standard `JSON.parse` silently accepts duplicate object keys (last-value-wins), a UTF-8 BOM (in some engines),
 * and — combined with sloppy callers — trailing data. That can diverge human review, signing review, and runtime
 * interpretation. This parser is deliberately strict and rejects, WITHOUT using a regex for structure:
 *   - a UTF-8 BOM (byte-level check)
 *   - invalid UTF-8 (decode + re-encode round-trip check)
 *   - duplicate object keys at ANY nesting depth
 *   - JSON comments (`//`, block) — an unexpected character error
 *   - trailing non-whitespace after the single top-level value
 *   - more than one top-level value (same trailing-data error)
 *   - non-finite numbers (grammar cannot express them; re-checked defensively)
 *   - unescaped control characters inside strings
 * Only JSON whitespace (space, tab, CR, LF) is skipped. A single numeric-token regex is used purely to scan a
 * number literal (tokenization, not duplicate detection).
 */

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

const JSON_WS = new Set<number>([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_TOKEN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;

class StrictParser {
  private i = 0;
  constructor(private readonly s: string) {}

  private fail(msg: string): never {
    throw new StrictJsonError(`${msg} at position ${this.i}`);
  }
  private atEnd(): boolean {
    return this.i >= this.s.length;
  }
  private peek(): string {
    if (this.atEnd()) this.fail('unexpected end of input');
    return this.s[this.i]!;
  }
  skipWs(): void {
    while (this.i < this.s.length && JSON_WS.has(this.s.charCodeAt(this.i))) this.i++;
  }
  end(): boolean {
    return this.atEnd();
  }

  value(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === '{') return this.object();
    if (c === '[') return this.array();
    if (c === '"') return this.string();
    if (c === '-' || (c >= '0' && c <= '9')) return this.number();
    if (this.s.startsWith('true', this.i)) return (this.i += 4), true;
    if (this.s.startsWith('false', this.i)) return (this.i += 5), false;
    if (this.s.startsWith('null', this.i)) return (this.i += 4), null;
    this.fail(`unexpected character ${JSON.stringify(c)}`);
  }

  private object(): Record<string, unknown> {
    this.i++; // consume {
    const obj: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.skipWs();
    if (this.peek() === '}') return (this.i++, obj);
    for (;;) {
      this.skipWs();
      if (this.peek() !== '"') this.fail('expected a string object key');
      const k = this.string();
      if (keys.has(k)) throw new StrictJsonError(`duplicate object key ${JSON.stringify(k)}`);
      keys.add(k);
      this.skipWs();
      if (this.peek() !== ':') this.fail('expected ":" after object key');
      this.i++;
      obj[k] = this.value();
      this.skipWs();
      const c = this.peek();
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') return (this.i++, obj);
      this.fail('expected "," or "}"');
    }
  }

  private array(): unknown[] {
    this.i++; // consume [
    const arr: unknown[] = [];
    this.skipWs();
    if (this.peek() === ']') return (this.i++, arr);
    for (;;) {
      arr.push(this.value());
      this.skipWs();
      const c = this.peek();
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') return (this.i++, arr);
      this.fail('expected "," or "]"');
    }
  }

  private string(): string {
    this.i++; // consume opening quote
    let out = '';
    for (;;) {
      if (this.atEnd()) this.fail('unterminated string');
      const ch = this.s[this.i]!;
      const code = this.s.charCodeAt(this.i);
      if (ch === '"') return (this.i++, out);
      if (ch === '\\') {
        this.i++;
        const e = this.s[this.i];
        if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') {
          const hex = this.s.slice(this.i + 1, this.i + 5);
          if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
        } else {
          this.fail('invalid escape sequence');
        }
        this.i++;
      } else if (code < 0x20) {
        this.fail('unescaped control character in string');
      } else {
        out += ch;
        this.i++;
      }
    }
  }

  private number(): number {
    const m = NUMBER_TOKEN.exec(this.s.slice(this.i));
    if (!m || m[0].length === 0) this.fail('invalid number');
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) throw new StrictJsonError('non-finite number');
    return n;
  }
}

/** Parse a strict-JSON text (already known to be valid UTF-8, no BOM). */
export function parseStrictJsonText(text: string): unknown {
  const p = new StrictParser(text);
  const v = p.value();
  p.skipWs();
  if (!p.end()) throw new StrictJsonError('trailing data after the top-level JSON value');
  return v;
}

/** Parse strict JSON from raw bytes: rejects a UTF-8 BOM and invalid UTF-8 before tokenizing. */
export function parseStrictJsonBuffer(buf: Buffer): unknown {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new StrictJsonError('UTF-8 BOM is not allowed');
  }
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new StrictJsonError('input is not valid UTF-8');
  return parseStrictJsonText(text);
}
