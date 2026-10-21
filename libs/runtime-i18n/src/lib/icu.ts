/**
 * ICU-style formatter with interpolation, plural, select, selectordinal,
 * number/date/time arguments, and ICU apostrophe quoting.
 * Used by the Angular service and pipe.
 * @experimental
 */
import type { Catalog, PluralCategory, PluralResolver } from './types';

// Tokens may include dots or hyphens so nested object keys like "user.name" are practical.
const INTERPOLATION_PATTERN = /\{([a-zA-Z_][a-zA-Z0-9_.-]*)\}/g;
const ARGUMENT_PATTERN = /\{(\w+),\s*(number|date|time)(?:,\s*([^{}]*?))?\s*\}/g;

// Quoted syntax characters are swapped for private-use code points while the
// message is parsed, so they can't open blocks, close blocks, or become `#`.
const QUOTED: Record<string, string> = { '{': '\uE000', '}': '\uE001', '#': '\uE002' };
const UNQUOTED: Record<string, string> = { '\uE000': '{', '\uE001': '}', '\uE002': '#' };

export function formatIcu(
  _lang: string,
  key: string,
  cat: Catalog,
  params: Record<string, unknown> | null = {},
  onMissingKey?: (k: string) => string,
  pluralResolver?: PluralResolver
): string {
  const raw = lookup(key, cat);
  if (raw == null) return onMissingKey ? onMissingKey(key) : key;

  const p = params ?? {};
  let out = protectQuoted(String(raw));

  // 1) Resolve {x, plural, ...}, {x, select, ...}, {x, selectordinal, ...} with a brace-balanced scanner.
  out = replaceMessageBlocks(out, _lang, p, pluralResolver);

  // 2) {x, number|date|time[, style]} arguments, including ones selected out of a block.
  out = out.replace(ARGUMENT_PATTERN, (m: string, arg: string, type: string, style?: string) =>
    p[arg] != null ? formatArgument(p[arg], type, style ?? '', _lang) : m
  );

  // 3) Simple {name} interpolation AFTER message block selection.
  INTERPOLATION_PATTERN.lastIndex = 0;
  out = out.replace(INTERPOLATION_PATTERN, (_m: string, p1: string) =>
    p[p1] != null ? String(p[p1]) : `{${p1}}`
  );

  // ponytail: runs after interpolation, so a param value containing U+E000-E002 also
  // turns into a brace/#. Escape param values first if that ever matters.
  return out.replace(/[\uE000-\uE002]/g, (c) => UNQUOTED[c]);
}

/**
 * ICU apostrophe quoting (ApostropheMode.DOUBLE_OPTIONAL, as in ICU4J and FormatJS):
 * `''` is a literal `'`; a `'` directly before `{`, `}` or `#` quotes text up to the
 * next lone `'` (or the end of the message); any other `'` is literal.
 */
function protectQuoted(s: string): string {
  if (!s.includes("'")) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (ch !== "'") { out += ch; continue; }
    const next = s.charAt(i + 1);
    if (next === "'") { out += "'"; i++; continue; }
    if (!(next in QUOTED)) { out += ch; continue; }
    for (i++; i < s.length; i++) {
      const q = s.charAt(i);
      if (q === "'") {
        if (s.charAt(i + 1) !== "'") break;
        i++;
      }
      out += QUOTED[q] ?? q;
    }
  }
  return out;
}

const DATE_STYLES = ['short', 'medium', 'long', 'full'];

function formatArgument(value: unknown, type: string, style: string, lang: string): string {
  if (type === 'number') {
    // Number('') and Number('  ') are 0; treat blank strings as unformattable instead.
    const n = typeof value === 'number' ? value : Number(String(value).trim() || NaN);
    if (!Number.isFinite(n)) return String(value);
    const currency = /^::currency\/(\S+)$/.exec(style);
    const opts: Intl.NumberFormatOptions =
      style === 'integer' ? { maximumFractionDigits: 0 }
      : style === 'percent' ? { style: 'percent' }
      : currency ? { style: 'currency', currency: currency[1] }
      : {};
    return cachedFormat('n', lang, style, () => new Intl.NumberFormat(normalizeLang(lang), opts))?.format(n) ?? String(value);
  }

  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return String(value);
  const s = (DATE_STYLES.includes(style) ? style : 'medium') as Intl.DateTimeFormatOptions['dateStyle'];
  const opts: Intl.DateTimeFormatOptions = type === 'date' ? { dateStyle: s } : { timeStyle: s };
  return cachedFormat(type, lang, s as string, () => new Intl.DateTimeFormat(normalizeLang(lang), opts))?.format(d) ?? String(value);
}

// ponytail: unbounded, but keys are (language x style) pairs from catalogs, a small fixed set.
const formatters = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | null>();

/** Builds formatters once per (kind, lang, style); `null` caches an invalid locale/currency. */
function cachedFormat<F extends Intl.NumberFormat | Intl.DateTimeFormat>(
  kind: string, lang: string, style: string, create: () => F
): F | null {
  const key = `${kind}|${lang}|${style}`;
  if (!formatters.has(key)) {
    let f: F | null = null;
    try { f = create(); } catch { /* RangeError: invalid locale or currency code */ }
    formatters.set(key, f);
  }
  return formatters.get(key) as F | null;
}

/** Intl rejects POSIX-style `en_US`; accept it as `en-US`. */
function normalizeLang(lang: string): string {
  return lang.replace(/_/g, '-');
}

function lookup(path: string, obj: unknown): unknown {
  return path
    .split('.')
    .reduce((o: unknown, k: string) =>
      o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
        ? (o as Record<string, unknown>)[k]
        : undefined,
      obj);
}

/**
 * Replace all `{arg, plural|select|selectordinal, ...}` blocks in `s` using a brace-balanced scan.
 */
function replaceMessageBlocks(
  s: string,
  lang: string,
  params: Record<string, unknown>,
  pluralResolver?: PluralResolver
): string {
  let i = 0;
  let out = '';

  while (i < s.length) {
    const start = s.indexOf('{', i);
    if (start === -1) { out += s.slice(i); break; }
    out += s.slice(i, start);

    // Try to match the prefix "{arg, plural|select|selectordinal,"
    const prefixMatch = /\{(\w+),\s*(plural|select|selectordinal),\s*/y;
    prefixMatch.lastIndex = start;
    const m = prefixMatch.exec(s);
    if (!m) {
      // Not a message block; copy '{' and continue scanning after it.
      out += '{';
      i = start + 1;
      continue;
    }

    const arg = m[1];
    const keyword = m[2] as 'plural' | 'select' | 'selectordinal';
    let j = prefixMatch.lastIndex; // position after the matched prefix

    // Find the matching closing '}' for the whole block with nesting.
    let depth = 1;
    while (j < s.length && depth > 0) {
      const ch = s.charAt(j++);
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }

    if (depth !== 0) {
      // Unbalanced; fall back to literal copy of the unmatched segment.
      out += s.slice(start, j);
      i = j;
      continue;
    }

    // Body is the contents between prefix end and the final '}'.
    const body = s.slice(prefixMatch.lastIndex, j - 1);
    const { offset, map: options } = parsePluralBody(body);

    if (keyword === 'plural' || keyword === 'selectordinal') {
      const n = Number(params[arg] ?? 0);
      if (Number.isFinite(n)) {
        const exact = options[`=${n}`];
        if (exact != null) {
          out += replaceHash(replaceMessageBlocks(exact, lang, params, pluralResolver), n - offset, lang);
          i = j;
          continue;
        }

        const shifted = n - offset;
        const category: PluralCategory = pluralResolver
          ? pluralResolver(shifted, lang)
          : Math.abs(shifted) === 1 ? 'one' : 'other';

        const match = options[category] ?? options['other'] ?? '';
        out += replaceHash(replaceMessageBlocks(match, lang, params, pluralResolver), shifted, lang);
      } else {
        out += replaceHash(replaceMessageBlocks(options['other'] ?? '', lang, params, pluralResolver), 0, lang);
      }
    } else {
      // select: look up param value directly, then resolve any nested keyword blocks
      const val = String(params[arg] ?? 'other');
      out += replaceMessageBlocks(options[val] ?? options['other'] ?? '', lang, params, pluralResolver);
    }

    i = j;
  }

  return out;
}

/** `#` is the plural count, formatted for the locale like `{n, number}` (1,234 / 1.234). */
function replaceHash(s: string, n: number, lang: string): string {
  return s.includes('#') ? s.replace(/#/g, formatArgument(n, 'number', '', lang)) : s;
}

/**
 * Parse a simple ICU plural/select clause body: e.g. `one {A} other {B} =0 {C}`.
 * Supports balanced brace bodies, nested forms, and a leading `offset:N` token.
 * The returned map has no prototype, so a selector value matching an
 * `Object.prototype` member name (e.g. "constructor") can never resolve to an
 * inherited function instead of `undefined`.
 */
function parsePluralBody(body: string): { offset: number; map: Record<string, string> } {
  const map: Record<string, string> = Object.create(null);
  const offsetMatch = /^\s*offset:\s*(\d+)\s*/.exec(body);
  const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
  let i = offsetMatch ? offsetMatch[0].length : 0;

  while (i < body.length) {
    // Skip whitespace between selectors.
    while (i < body.length && /\s/.test(body.charAt(i))) i++;
    if (i >= body.length) break;

    const keyStart = i;
    while (i < body.length && !/[\s{]/.test(body.charAt(i))) i++;
    if (keyStart === i) break;
    const key = body.slice(keyStart, i);

    // Skip whitespace before the opening brace.
    while (i < body.length && /\s/.test(body.charAt(i))) i++;
    if (body.charAt(i) !== '{') break;
    i++; // Consume '{'

    const valueStart = i;
    let depth = 1;
    // Consume until the matching closing brace; supports nested braces for placeholders.
    while (i < body.length && depth > 0) {
      const ch = body.charAt(i++);
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) {
      // Unbalanced braces (malformed plural); bail out to avoid infinite loops.
      break;
    }

    map[key] = body.slice(valueStart, i - 1);
  }

  return { offset, map };
}
