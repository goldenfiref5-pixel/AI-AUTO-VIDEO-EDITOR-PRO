/**
 * LLM JSON responses arrive wrapped in prose or fenced code blocks often enough
 * that a bare `JSON.parse` is not usable. These helpers recover the payload.
 */

function stripCodeFence(text: string): string {
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  return fence?.[1] ?? text;
}

/** Find the first balanced `{...}` or `[...]` block, ignoring braces in strings. */
function extractBalanced(text: string): string | null {
  const openers: Record<string, string> = { '{': '}', '[': ']' };
  let start = -1;
  let opener = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '{' || ch === '[') {
      start = i;
      opener = ch;
      break;
    }
  }
  if (start === -1) return null;

  const closer = openers[opener]!;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Drop trailing commas, which models emit surprisingly often. */
function repairCommon(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonLoose<T = unknown>(raw: string): T {
  const candidates = [raw, stripCodeFence(raw)];
  const balanced = extractBalanced(stripCodeFence(raw));
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    for (const attempt of [trimmed, repairCommon(trimmed)]) {
      try {
        return JSON.parse(attempt) as T;
      } catch {
        // try the next repair strategy
      }
    }
  }

  throw new Error(`Model response was not valid JSON: ${raw.slice(0, 400)}`);
}

export function tryParseJson<T = unknown>(raw: string): T | null {
  try {
    return parseJsonLoose<T>(raw);
  } catch {
    return null;
  }
}

export function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  return [value as T];
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.toLowerCase());
  return fallback;
}

/** Recursively merge `patch` into `base`; arrays and nulls replace wholesale. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    out[key] = deepMerge(out[key], value);
  }
  return out as T;
}
