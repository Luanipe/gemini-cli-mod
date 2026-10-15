/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileReadStateTracker, hashContent } from './fileReadState.js';

describe('FileReadStateTracker', () => {
  let tmpDir: string;
  let tracker: FileReadStateTracker;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-state-'));
    tracker = new FileReadStateTracker();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function filePath(name: string): string {
    return path.join(tmpDir, name);
  }

  it('reports a missing, never-read file as new-file', async () => {
    const check = await tracker.checkFreshness(filePath('new.ts'));
    expect(check.status).toBe('new-file');
  });

  it('reports an existing, never-read file as not-read', async () => {
    const p = filePath('existing.ts');
    await fs.writeFile(p, 'hello');
    const check = await tracker.checkFreshness(p);
    expect(check.status).toBe('not-read');
  });

  it('reports a read file as fresh', async () => {
    const p = filePath('a.ts');
    await fs.writeFile(p, 'export const a = 1;\n');
    await tracker.recordRead(p, 'export const a = 1;\n');
    const check = await tracker.checkFreshness(p);
    expect(check.status).toBe('fresh');
    expect(check.record?.contentHash).toBe(
      hashContent('export const a = 1;\n'),
    );
  });

  it('reports a modified file as stale', async () => {
    const p = filePath('b.ts');
    await fs.writeFile(p, 'v1');
    await tracker.recordRead(p, 'v1');
    await fs.writeFile(p, 'v2');
    const check = await tracker.checkFreshness(p);
    expect(check.status).toBe('stale');
  });

  it('treats a touched-but-unchanged file as fresh', async () => {
    const p = filePath('c.ts');
    await fs.writeFile(p, 'same');
    await tracker.recordRead(p, 'same');
    // Change mtime without changing content.
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(p, future, future);
    const check = await tracker.checkFreshness(p);
    expect(check.status).toBe('fresh');
  });

  it('hashes raw bytes so a CRLF-normalized read stays fresh', async () => {
    const p = filePath('crlf.ts');
    await fs.writeFile(p, 'a\r\nb\r\n');
    // The read pipeline normalizes CRLF to LF before showing the content.
    await tracker.recordRead(p, 'a\nb\n');
    expect((await tracker.checkFreshness(p)).status).toBe('fresh');
    await fs.writeFile(p, 'a\r\nb\r\nc\r\n');
    expect((await tracker.checkFreshness(p)).status).toBe('stale');
  });

  it('reports a file that disappeared since read as stale', async () => {
    const p = filePath('gone.ts');
    await fs.writeFile(p, 'bye');
    await tracker.recordRead(p, 'bye');
    await fs.rm(p);
    const check = await tracker.checkFreshness(p);
    expect(check.status).toBe('stale');
  });

  it('hashes the whole file for partial reads and merges ranges', async () => {
    const p = filePath('partial.ts');
    const full = 'line1\nline2\nline3\nline4\n';
    await fs.writeFile(p, full);
    await tracker.recordRead(p, 'line2\nline3\n', {
      startLine: 2,
      endLine: 3,
    });
    let record = tracker.get(p);
    expect(record?.ranges).toEqual([[2, 3]]);
    expect(record?.contentHash).toBe(hashContent(full));
    // A freshness check still works against the whole file.
    expect((await tracker.checkFreshness(p)).status).toBe('fresh');

    // A second, adjacent partial read merges the ranges.
    await tracker.recordRead(p, 'line4\n', { startLine: 4, endLine: 4 });
    record = tracker.get(p);
    expect(record?.ranges).toEqual([[2, 4]]);
  });

  it('resets ranges when a whole-file read happens after a partial read', async () => {
    const p = filePath('whole.ts');
    await fs.writeFile(p, 'a\nb\nc\n');
    await tracker.recordRead(p, 'a\n', { startLine: 1, endLine: 1 });
    expect(tracker.get(p)?.ranges).toEqual([[1, 1]]);
    await tracker.recordRead(p, 'a\nb\nc\n');
    expect(tracker.get(p)?.ranges).toEqual([]);
  });

  it('keeps the record fresh after a write', async () => {
    const p = filePath('written.ts');
    await fs.writeFile(p, 'old');
    await tracker.recordRead(p, 'old');
    await fs.writeFile(p, 'new content');
    await tracker.recordWrite(p, 'new content');
    expect((await tracker.checkFreshness(p)).status).toBe('fresh');
  });

  it('marks records as masked', async () => {
    const p = filePath('m.ts');
    await fs.writeFile(p, 'x');
    await tracker.recordRead(p, 'x');
    expect(tracker.get(p)?.masked).toBe(false);
    tracker.markMasked(p);
    expect(tracker.get(p)?.masked).toBe(true);
  });

  it('marks all records as masked', async () => {
    const p1 = filePath('m1.ts');
    const p2 = filePath('m2.ts');
    await fs.writeFile(p1, '1');
    await fs.writeFile(p2, '2');
    await tracker.recordRead(p1, '1');
    await tracker.recordRead(p2, '2');
    tracker.markAllMasked();
    expect(tracker.get(p1)?.masked).toBe(true);
    expect(tracker.get(p2)?.masked).toBe(true);
  });

  it('orders recentlyTouched by most recent first', async () => {
    const p1 = filePath('r1.ts');
    const p2 = filePath('r2.ts');
    await fs.writeFile(p1, '1');
    await fs.writeFile(p2, '2');
    await tracker.recordRead(p1, '1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tracker.recordRead(p2, '2');
    const recent = tracker.recentlyTouched(5);
    expect(recent.map((r) => r.path)).toEqual([
      path.resolve(p2),
      path.resolve(p1),
    ]);
  });

  it('invalidates a record', async () => {
    const p = filePath('inv.ts');
    await fs.writeFile(p, 'x');
    await tracker.recordRead(p, 'x');
    tracker.invalidate(p);
    expect(tracker.get(p)).toBeUndefined();
    expect(tracker.size).toBe(0);
  });
});
