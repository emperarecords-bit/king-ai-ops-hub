import 'server-only';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { isCanonicalObjectKey, isVerificationArtifactKey, type ObjectStore, ObjectNotFoundError, type StoredObjectHead, VerificationObjectWriteError } from './object-store';

/**
 * Filesystem-backed ObjectStore for dev and hermetic tests (O-23). Keys map to
 * files under a base directory; a sidecar `.meta` holds the content type. The
 * production path uses S3ObjectStore — this is deliberately simple, but it
 * enforces the SAME contract: keys are opaque, traversal outside the base is
 * rejected, and a missing key throws ObjectNotFoundError.
 */
export class LocalObjectStore implements ObjectStore {
  readonly driver = 'local' as const;
  private readonly base: string;

  constructor(base?: string) {
    this.base = resolve(base ?? process.env.LOCAL_OBJECT_STORE_DIR ?? join(tmpdir(), 'king-object-store'));
  }

  /** The absolute storage root. Exposed so the verification create-only writer can stage a temp file on
   *  the SAME filesystem and atomically link it to the final key. */
  get baseDir(): string {
    return this.base;
  }

  /** Resolve a key to an absolute path, refusing traversal, backslashes, and
   *  anything that escapes base. `..`/`.` segments are rejected outright rather
   *  than silently collapsed by resolve(). */
  private pathFor(key: string): string {
    // Reject non-canonical keys (backslash/NUL, `.`/`..`, and — critically — empty `//` segments that
    // `resolve` would otherwise collapse) so no alias can resolve onto another key's path.
    if (!isCanonicalObjectKey(key)) {
      throw new Error('non-canonical object key');
    }
    const full = resolve(this.base, key);
    if (full !== this.base && !full.startsWith(this.base + sep)) {
      throw new Error('object key escapes storage root');
    }
    return full;
  }

  /**
   * Does `key` resolve INSIDE `tenantDirKey` (e.g. `org/A/project/P`)? Follows
   * symlinks on the real object path and compares against the LEXICAL tenant
   * directory, so a symlinked tenant dir cannot smuggle in another project's
   * data. Used by the verification artifact adapter for symlink-escape defense.
   */
  async keyStaysWithinTenant(key: string, tenantDirKey: string): Promise<boolean> {
    let target: string;
    let tenantDir: string;
    try {
      target = this.pathFor(key);
      tenantDir = this.pathFor(tenantDirKey);
    } catch {
      return false;
    }
    let real: string;
    try {
      real = await realpath(target); // resolves symlinks; only works if it exists
    } catch {
      real = target; // not created yet — the lexical path is authoritative
    }
    return real === tenantDir || real.startsWith(tenantDir + sep);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // Reject non-canonical keys BEFORE classification, so a doubled-slash (or other) alias that would
    // collapse onto a verification object cannot dodge the guard below.
    if (!isCanonicalObjectKey(key)) throw new Error('non-canonical object key');
    // Ordinary put MUST NOT overwrite (or create) a verification artifact object — those are written
    // only through the create-only exclusive publisher. Fail closed rather than clobber one.
    if (isVerificationArtifactKey(key)) throw new VerificationObjectWriteError(key);
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    await writeFile(`${p}.meta`, JSON.stringify({ contentType, size: body.length }));
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new ObjectNotFoundError(key);
    }
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    try {
      const s = await stat(this.pathFor(key));
      let contentType: string | null = null;
      try {
        contentType = JSON.parse(await readFile(`${this.pathFor(key)}.meta`, 'utf8')).contentType ?? null;
      } catch {
        /* meta optional */
      }
      return { size: s.size, contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    await rm(p, { force: true });
    await rm(`${p}.meta`, { force: true });
  }

  /** Recursively list object keys under `prefix` (excludes the `.meta` sidecars). Keys are returned in
   *  the same forward-slash form used to store them. Read-only; used by the backfill orphan scan. */
  async list(prefix: string): Promise<string[]> {
    const root = this.pathFor(prefix);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // prefix has no objects yet
      }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (!e.name.endsWith('.meta')) {
          out.push(full.slice(this.base.length + 1).split(sep).join('/'));
        }
      }
    };
    await walk(root);
    return out;
  }
}
