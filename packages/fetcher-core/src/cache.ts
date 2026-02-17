/**
 * Generic endpoint-based API cache with structured cache keys.
 * 
 * Cache keys are structured objects with a namespace (used as a subfolder)
 * and an array of parts (hashed to produce the filename). This design:
 * 
 * - Prevents data mixing between different API hosts (each host gets its own subfolder)
 * - Produces deterministic, fixed-length filenames via hashing
 * - Stores the original key parts in each cache entry for debuggability
 * 
 * File layout: `.cache/{namespace}/{hash}.json`
 * 
 * The cache is shared across all entry points — any fetch task that
 * hits the same API endpoint benefits from cached responses.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const CACHE_ROOT = join(process.cwd(), '.cache');

// ─── Cache Key Types ─────────────────────────────────────────────────────────

/**
 * Structured cache key.
 * 
 * - `namespace`: subfolder name (typically the sanitized API hostname)
 * - `parts`: ordered array of strings that uniquely identify the cached resource
 */
export interface CacheKey {
  namespace: string;
  parts: string[];
}

/**
 * Strategy for converting cache key parts into a filename.
 * Injectable for testing or alternative hashing strategies.
 */
export interface CacheKeyHasher {
  hash(parts: string[]): string;
}

/**
 * Default hasher: SHA-256 of the joined parts, truncated to 32 hex chars.
 * The separator is a null byte to prevent ambiguity between parts.
 */
export class DefaultHasher implements CacheKeyHasher {
  hash(parts: string[]): string {
    const input = parts.join('\0');
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }
}

// ─── Cache Key Helpers ───────────────────────────────────────────────────────

/**
 * Create a CacheKey from a namespace and parts.
 */
export function cacheKey(namespace: string, ...parts: string[]): CacheKey {
  return { namespace, parts };
}

/**
 * Create a CacheKey for a REST API call.
 * Prefixes parts with 'rest' to avoid collisions with GraphQL for the same resource.
 */
export function restCacheKey(namespace: string, ...parts: string[]): CacheKey {
  return { namespace, parts: ['rest', ...parts] };
}

/**
 * Create a CacheKey for a GraphQL API call.
 * Prefixes parts with 'graphql' to avoid collisions with REST for the same resource.
 */
export function graphqlCacheKey(namespace: string, ...parts: string[]): CacheKey {
  return { namespace, parts: ['graphql', ...parts] };
}

/**
 * Sanitize a hostname for use as a filesystem directory name.
 * Strips protocol, removes port numbers, lowercases, and replaces unsafe chars.
 */
export function sanitizeHostname(hostname: string): string {
  return hostname
    .replace(/^https?:\/\//, '')  // strip protocol
    .replace(/\/+$/, '')          // strip trailing slashes
    .replace(/:\d+$/, '')         // strip port
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');
}

// ─── Cache Entry ─────────────────────────────────────────────────────────────

export interface CacheEntry<T> {
  data: T;
  cachedAt: string;
  /** Original key parts stored for debuggability */
  keyParts: string[];
  metadata?: Record<string, string>;
}

export interface CacheOptions {
  /** Override the default cache root directory */
  cacheRoot?: string;
  /** Override the default key hasher */
  hasher?: CacheKeyHasher;
}

// ─── ApiCache ────────────────────────────────────────────────────────────────

/**
 * Generic API response cache backed by the filesystem.
 * 
 * File layout: `{cacheRoot}/{key.namespace}/{hash(key.parts)}.json`
 */
export class ApiCache {
  private readonly cacheRoot: string;
  private readonly hasher: CacheKeyHasher;

  constructor(options?: CacheOptions) {
    this.cacheRoot = options?.cacheRoot ?? CACHE_ROOT;
    this.hasher = options?.hasher ?? new DefaultHasher();
  }

  /**
   * Ensure the cache root directory exists.
   */
  ensureDirectory(): void {
    if (!existsSync(this.cacheRoot)) {
      mkdirSync(this.cacheRoot, { recursive: true });
    }
  }

  /**
   * Get a cached response by key.
   * Returns null if not cached.
   */
  get<T>(key: CacheKey): T | null {
    const filePath = this.keyToPath(key);
    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf8');
      const entry: CacheEntry<T> = JSON.parse(content);
      return entry.data;
    } catch {
      return null;
    }
  }

  /**
   * Store a response in the cache.
   */
  set<T>(key: CacheKey, data: T, metadata?: Record<string, string>): void {
    const filePath = this.keyToPath(key);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const entry: CacheEntry<T> = {
      data,
      cachedAt: new Date().toISOString(),
      keyParts: key.parts,
      metadata,
    };

    writeFileSync(filePath, JSON.stringify(entry, null, 2));
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: CacheKey): boolean {
    return existsSync(this.keyToPath(key));
  }

  /**
   * Convert a structured cache key to a file path.
   * 
   * Layout: `{cacheRoot}/{namespace}/{hash}.json`
   */
  private keyToPath(key: CacheKey): string {
    const hash = this.hasher.hash(key.parts);
    return join(this.cacheRoot, key.namespace, `${hash}.json`);
  }
}
