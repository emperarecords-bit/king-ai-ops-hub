/** Pure path-policy preview. It performs no filesystem access and grants no execution authority. */

export const FILE_WRITE_ALLOWED_EXTENSIONS = ['.txt', '.md', '.json', '.yaml', '.yml', '.csv'] as const;
export const FILE_WRITE_MAX_PATH_BYTES = 240;
export const FILE_WRITE_MAX_PATH_SEGMENTS = 12;
const SEGMENT = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u;
const RESERVED_SEGMENTS = new Set(['.git', '.hg', '.svn', 'node_modules', '.next', 'vendor', 'dist', 'build', 'coverage']);
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SECRET_NAME = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|password|passwd|private[-_]?key|authorized[-_]?keys|npmrc|pypirc|netrc|dockerconfigjson)([._-]|$)/i;
const FORBIDDEN_EXTENSION = /\.(?:pem|key|p12|pfx|crt|cer|der|sh|bash|zsh|ps1|bat|cmd|com|exe|dll|so|dylib|wasm|js|mjs|cjs|ts|tsx|py|rb|php|jar|class|tf|tfvars)$/i;

export type FileWritePathDecision =
  | { readonly allowed: true; readonly normalizedPath: string; readonly collisionKey: string; readonly extension: typeof FILE_WRITE_ALLOWED_EXTENSIONS[number] }
  | { readonly allowed: false; readonly reason: string };

export function validateFileWriteRelativePath(input: unknown): FileWritePathDecision {
  if (typeof input !== 'string' || input.length === 0) return { allowed: false, reason: 'path must be a non-empty string' };
  if (input !== input.normalize('NFC')) return { allowed: false, reason: 'path must already be NFC-normalized' };
  if (Buffer.byteLength(input, 'utf8') > FILE_WRITE_MAX_PATH_BYTES) return { allowed: false, reason: 'path exceeds 240 UTF-8 bytes' };
  if (input.startsWith('/') || input.startsWith('\\') || input.includes('\\') || /^[A-Za-z]:/.test(input) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input)) return { allowed: false, reason: 'absolute, UNC, drive, scheme, and backslash paths are denied' };
  if (/[\0-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(input)) return { allowed: false, reason: 'control and invisible direction-changing characters are denied' };
  const parts = input.split('/');
  if (parts.length > FILE_WRITE_MAX_PATH_SEGMENTS) return { allowed: false, reason: 'path depth exceeds 12 segments' };
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!SEGMENT.test(part) || part.endsWith('.') || part.endsWith(' ')) return { allowed: false, reason: 'path contains an empty, dot, whitespace, trailing-dot, or unsafe segment' };
    if (part.startsWith('.')) return { allowed: false, reason: 'dot-prefixed paths are denied' };
    if (RESERVED_SEGMENTS.has(lower)) return { allowed: false, reason: 'repository, dependency, build, and metadata paths are denied' };
    if (WINDOWS_DEVICE.test(part)) return { allowed: false, reason: 'Windows device names are denied' };
    if (SECRET_NAME.test(part) || FORBIDDEN_EXTENSION.test(part)) return { allowed: false, reason: 'secret, configuration, executable, and binary file classes are denied' };
  }
  const last = parts.at(-1)!;
  const dot = last.lastIndexOf('.');
  const extension = (dot >= 0 ? last.slice(dot).toLowerCase() : '') as typeof FILE_WRITE_ALLOWED_EXTENSIONS[number];
  if (!FILE_WRITE_ALLOWED_EXTENSIONS.includes(extension)) return { allowed: false, reason: 'extension is not in the initial text allowlist' };
  const normalizedPath = parts.join('/');
  return { allowed: true, normalizedPath, collisionKey: normalizedPath.toLocaleLowerCase('en-US'), extension };
}

