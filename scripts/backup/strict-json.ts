/**
 * G-Backup-A Phase-10 hardening — a strict, recursive-descent JSON parser for ACTIVE governance files.
 *
 * Rejects (no regex for structure or duplicate detection):
 *   - a UTF-8 BOM (byte-level) and invalid UTF-8 (decode + re-encode round-trip)
 *   - duplicate object keys at ANY nesting depth, compared on the DECODED + NFC-normalized key value (so
 *     `"key"` vs `"key"` and `"é"` vs `"é"` are duplicates — matching how the canonicalizer collapses
 *     keys)
 *   - unpaired / invalid UTF-16 surrogate escapes in any string; valid surrogate pairs decode to one code point
 *   - JSON comments, trailing data / multiple top-level values
 *   - unescaped control characters in strings
 *   - numbers that are not exactly representable as an IEEE-754 double (see NUMERIC POLICY below)
 *
 * NUMERIC POLICY: integer literals must be safe integers (|n| ≤ Number.MAX_SAFE_INTEGER); any literal that
 * overflows to a non-finite value is rejected; a NONZERO fractional/exponent literal that underflows to 0 is
 * rejected; leading-zero forms (`01`) are rejected by the number grammar. All current governance numbers,
 * including `journalTimestamp` = 1784873208836 (< 2^53), remain accepted. No bigint is introduced here.
 */

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrictJsonError';
  }
}

const JSON_WS = new Set<number>([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_TOKEN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const HEX4 = /^[0-9a-fA-F]{4}$/;

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
    const seen = new Set<string>(); // decoded + NFC-normalized keys
    this.skipWs();
    if (this.peek() === '}') return (this.i++, obj);
    for (;;) {
      this.skipWs();
      if (this.peek() !== '"') this.fail('expected a string object key');
      const key = this.string();
      const semantic = key.normalize('NFC');
      if (seen.has(semantic)) throw new StrictJsonError(`duplicate object key (decoded+NFC) ${JSON.stringify(semantic)}`);
      seen.add(semantic);
      this.skipWs();
      if (this.peek() !== ':') this.fail('expected ":" after object key');
      this.i++;
      obj[key] = this.value();
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

  /** Read exactly 4 hex digits starting at this.i; advance past them; return the code unit. */
  private hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (h.length !== 4 || !HEX4.test(h)) this.fail('invalid \\u escape');
    this.i += 4;
    return parseInt(h, 16);
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
        this.i++; // move to escape char
        const e = this.s[this.i];
        if (e === '"') { out += '"'; this.i++; }
        else if (e === '\\') { out += '\\'; this.i++; }
        else if (e === '/') { out += '/'; this.i++; }
        else if (e === 'b') { out += '\b'; this.i++; }
        else if (e === 'f') { out += '\f'; this.i++; }
        else if (e === 'n') { out += '\n'; this.i++; }
        else if (e === 'r') { out += '\r'; this.i++; }
        else if (e === 't') { out += '\t'; this.i++; }
        else if (e === 'u') {
          this.i++; // move to first hex digit
          const cu = this.hex4();
          if (cu >= 0xd800 && cu <= 0xdbff) {
            // high surrogate — must be immediately followed by a \u low surrogate
            if (this.s[this.i] === '\\' && this.s[this.i + 1] === 'u') {
              this.i += 2;
              const lo = this.hex4();
              if (lo < 0xdc00 || lo > 0xdfff) this.fail('invalid low surrogate after high surrogate');
              out += String.fromCharCode(cu, lo);
            } else {
              this.fail('unpaired high surrogate');
            }
          } else if (cu >= 0xdc00 && cu <= 0xdfff) {
            this.fail('unpaired low surrogate');
          } else {
            out += String.fromCharCode(cu);
          }
        } else {
          this.fail('invalid escape sequence');
        }
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
    const tok = m[0];
    this.i += tok.length;
    const n = Number(tok);
    if (!Number.isFinite(n)) throw new StrictJsonError('non-finite / overflowing number');
    const fractional = /[.eE]/.test(tok);
    if (!fractional) {
      if (!Number.isSafeInteger(n)) throw new StrictJsonError('integer outside the IEEE-754 safe range');
    } else if (n === 0 && /[1-9]/.test(tok)) {
      throw new StrictJsonError('nonzero number underflowed to zero');
    }
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
