/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Where a read/write record originated.
 */
export type FileReadSource = 'read_file' | 'read_many_files' | 'edit' | 'write';

/**
 * A record of the last time a file's content was made available to (or written
 * by) the model. It is used to detect edits/writes that are based on stale or
 * never-seen content, which is a common source of hallucinated changes.
 */
export interface FileReadRecord {
  /** Absolute, canonicalized path of the file. */
  path: string;
  /** SHA-256 hex digest of the content the model last saw. */
  contentHash: string;
  /** File size in bytes captured at read/write time. */
  size: number;
  /** mtime in milliseconds captured at read/write time. */
  mtimeMs: number;
  /**
   * 1-based inclusive line ranges the model actually saw. An empty array means
   * the whole file was available.
   */
  ranges: Array<[number, number]>;
  /** Timestamp (ms) of the most recent read/write recorded for this file. */
  lastTouchedAt: number;
  /**
   * True when the content this record refers to has been removed from the
   * model's context (masked or distilled away). The model may still be allowed
   * to edit the file, but the content is no longer in its context and may need
   * to be re-injected after a compaction.
   */
  masked: boolean;
  /** Where the record came from. */
  source: FileReadSource;
}

/**
 * Result of comparing a stored record against the current on-disk file.
 */
export type FileFreshnessStatus = 'new-file' | 'not-read' | 'stale' | 'fresh';

export interface FileFreshnessCheck {
  status: FileFreshnessStatus;
  record?: FileReadRecord;
}

export interface RecordReadOptions {
  /** 1-based first line the model saw, when a partial read was performed. */
  startLine?: number;
  /** 1-based last line the model saw, when a partial read was performed. */
  endLine?: number;
  /** Origin of the read. Defaults to 'read_file'. */
  source?: FileReadSource;
}

/**
 * Computes a stable SHA-256 digest for file content.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Tracks which files the model has read (or written) during the current
 * session, so tools can refuse to act on content the model has not seen or
 * that has changed on disk since it was seen.
 *
 * This is deliberately session-scoped: it lives on {@link Config}, which is not
 * recreated when the chat history is reset during compression.
 */
export class FileReadStateTracker {
  private readonly records = new Map<string, FileReadRecord>();

  private key(filePath: string): string {
    return path.resolve(filePath);
  }

  /**
   * Records that `content` for `filePath` is now available to the model.
   */
  async recordRead(
    filePath: string,
    content: string,
    options: RecordReadOptions = {},
  ): Promise<void> {
    const key = this.key(filePath);
    const stat = await statOrNull(key);
    const existing = this.records.get(key);
    const ranges = buildRanges(options.startLine, options.endLine);

    let rangesToStore: Array<[number, number]>;
    if (options.startLine === undefined && options.endLine === undefined) {
      // Whole-file read: replace any previous partial range info.
      rangesToStore = [];
    } else {
      rangesToStore = mergeRanges(existing?.ranges ?? [], ranges);
    }

    // Freshness is evaluated against the *raw on-disk bytes*, not the content
    // shown to the model: the read pipeline normalizes line endings, strips a
    // BOM, and truncates long lines, so the visible text would not hash-match
    // the file. Reading the raw content here keeps record and check consistent.
    let hashSource = content;
    try {
      hashSource = await fs.readFile(key, 'utf8');
    } catch {
      hashSource = content;
    }

    this.records.set(key, {
      path: key,
      contentHash: hashContent(hashSource),
      size: stat?.size ?? Buffer.byteLength(hashSource, 'utf8'),
      mtimeMs: stat?.mtimeMs ?? Date.now(),
      ranges: rangesToStore,
      lastTouchedAt: Date.now(),
      masked: false,
      source: options.source ?? 'read_file',
    });
  }

  /**
   * Records a file write performed by the agent. The written content is now the
   * freshest known state, so subsequent edits do not require another read.
   */
  async recordWrite(
    filePath: string,
    content: string,
    source: FileReadSource = 'edit',
  ): Promise<void> {
    const key = this.key(filePath);
    const stat = await statOrNull(key);
    this.records.set(key, {
      path: key,
      contentHash: hashContent(content),
      size: stat?.size ?? Buffer.byteLength(content, 'utf8'),
      mtimeMs: stat?.mtimeMs ?? Date.now(),
      ranges: [],
      lastTouchedAt: Date.now(),
      masked: false,
      source,
    });
  }

  /** Drops the record for a path, forcing a future read. */
  invalidate(filePath: string): void {
    this.records.delete(this.key(filePath));
  }

  /** Returns the stored record for a path, if any. */
  get(filePath: string): FileReadRecord | undefined {
    return this.records.get(this.key(filePath));
  }

  /**
   * Marks all records whose path matches as masked. Used when tool outputs are
   * removed from the model context by masking or distillation.
   */
  markMasked(filePath: string): void {
    const record = this.records.get(this.key(filePath));
    if (record) {
      record.masked = true;
    }
  }

  /**
   * Marks every record for which `predicate` returns true as masked.
   */
  markMaskedWhere(predicate: (record: FileReadRecord) => boolean): void {
    for (const record of this.records.values()) {
      if (predicate(record)) {
        record.masked = true;
      }
    }
  }

  /**
   * Marks every tracked record as masked. Used when the model context is
   * rewritten wholesale (compaction) or when a retrieval tool output is
   * removed from history, so verbatim file content can no longer be assumed to
   * be present.
   */
  markAllMasked(): void {
    for (const record of this.records.values()) {
      record.masked = true;
    }
  }

  /** Returns every tracked record. */
  list(): FileReadRecord[] {
    return [...this.records.values()];
  }

  /**
   * Returns up to `limit` records ordered by most recently touched first.
   */
  recentlyTouched(limit: number): FileReadRecord[] {
    return this.list()
      .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
      .slice(0, limit);
  }

  /** Removes every record. */
  clear(): void {
    this.records.clear();
  }

  /** Number of tracked files. */
  get size(): number {
    return this.records.size;
  }

  /**
   * Compares the stored record for `filePath` against the current on-disk file.
   *
   * - `new-file`: the file does not exist and was never read (safe to create).
   * - `not-read`: the file exists but the model has not read it.
   * - `stale`: the model read it, but it changed on disk since.
   * - `fresh`: the model read it and it is unchanged.
   */
  async checkFreshness(filePath: string): Promise<FileFreshnessCheck> {
    const key = this.key(filePath);
    const record = this.records.get(key);

    if (!record) {
      const stat = await statOrNull(key);
      return { status: stat ? 'not-read' : 'new-file' };
    }

    const stat = await statOrNull(key);
    if (!stat) {
      // The file existed when it was read but is gone now.
      return { status: 'stale', record };
    }

    if (stat.mtimeMs === record.mtimeMs && stat.size === record.size) {
      return { status: 'fresh', record };
    }

    // mtime/size differ. Verify by content hash so a mere touch (no content
    // change) does not produce a false "stale".
    try {
      const currentContent = await fs.readFile(key, 'utf8');
      if (hashContent(currentContent) === record.contentHash) {
        record.mtimeMs = stat.mtimeMs;
        record.size = stat.size;
        return { status: 'fresh', record };
      }
    } catch {
      // Fall through to stale.
    }

    return { status: 'stale', record };
  }
}

function buildRanges(
  startLine?: number,
  endLine?: number,
): Array<[number, number]> {
  if (startLine === undefined && endLine === undefined) {
    return [];
  }
  const start = startLine ?? 1;
  const end = endLine ?? Number.POSITIVE_INFINITY;
  return [[start, end]];
}

function mergeRanges(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0]);
  const merged: Array<[number, number]> = [];
  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + 1) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([range[0], range[1]]);
    }
  }
  return merged;
}

async function statOrNull(
  filePath: string,
): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return null;
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}
