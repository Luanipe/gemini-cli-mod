/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Content } from '@google/genai';
import {
  buildRecentFileReinjection,
  DEFAULT_RECENT_FILE_REINJECTION,
  PER_FILE_TRUNCATION_MARKER,
  RECENTLY_REFERENCED_FILES_TAG,
  TOTAL_TRUNCATION_MARKER,
  type RecentFileReinjectionSettings,
} from './recentFileReinjection.js';
import type { FileReadRecord } from '../utils/fileReadState.js';

function makeRecord(filePath: string, touchedAt: number): FileReadRecord {
  return {
    path: filePath,
    contentHash: 'hash',
    size: 0,
    mtimeMs: 0,
    ranges: [],
    lastTouchedAt: touchedAt,
    masked: false,
    source: 'read_file',
  };
}

function readResponse(content: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: { name: 'read_file', response: { output: content } },
      },
    ],
  };
}

describe('buildRecentFileReinjection', () => {
  let tempDir: string;
  let settings: RecentFileReinjectionSettings;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reinjection-test-'));
    settings = { ...DEFAULT_RECENT_FILE_REINJECTION };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFile(name: string, content: string): string {
    const filePath = path.join(tempDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('returns null when disabled', async () => {
    const filePath = writeFile('a.ts', 'export const a = 1;');
    const result = await buildRecentFileReinjection(
      [makeRecord(filePath, 1)],
      [],
      { ...settings, enabled: false },
    );
    expect(result.content).toBeNull();
    expect(result.injectedPaths).toEqual([]);
  });

  it('returns null when there are no records', async () => {
    const result = await buildRecentFileReinjection([], [], settings);
    expect(result.content).toBeNull();
  });

  it('re-injects recently touched files read from disk, most recent first', async () => {
    const older = writeFile('older.ts', 'export const older = 1;');
    const newer = writeFile('newer.ts', 'export const newer = 2;');

    const result = await buildRecentFileReinjection(
      [makeRecord(newer, 2), makeRecord(older, 1)],
      [],
      settings,
    );

    expect(result.content).not.toBeNull();
    const text = result.content!.parts![0].text!;
    expect(text).toContain(`<${RECENTLY_REFERENCED_FILES_TAG}>`);
    expect(result.injectedPaths).toEqual([newer, older]);
    expect(text.indexOf('newer.ts')).toBeLessThan(text.indexOf('older.ts'));
    expect(text).toContain('export const newer = 2;');
  });

  it('re-reads current content from disk rather than using stale content', async () => {
    const filePath = writeFile('changed.ts', 'export const value = 1;');
    const result = await buildRecentFileReinjection(
      [makeRecord(filePath, 1)],
      [],
      settings,
    );
    const text = result.content!.parts![0].text!;
    expect(text).toContain('export const value = 1;');
    expect(text).not.toContain('export const value = 999;');
  });

  it('skips files whose content is still verbatim in the preserved tail', async () => {
    const filePath = writeFile('present.ts', 'export const present = 1;');
    const preserved = [readResponse('export const present = 1;')];

    const result = await buildRecentFileReinjection(
      [makeRecord(filePath, 1)],
      preserved,
      settings,
    );

    expect(result.content).toBeNull();
    expect(result.skippedPresentPaths).toEqual([filePath]);
  });

  it('re-injects a file after its content was masked out of the tail', async () => {
    const filePath = writeFile('masked.ts', 'export const masked = 1;');
    // Tool-output masking replaces the response with a short snippet.
    const preserved = [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: {
                output:
                  '<tool_output_masked file="masked.ts">[truncated]</tool_output_masked>',
              },
            },
          },
        ],
      },
    ];

    const result = await buildRecentFileReinjection(
      [makeRecord(filePath, 1)],
      preserved,
      settings,
    );

    expect(result.content).not.toBeNull();
    expect(result.injectedPaths).toEqual([filePath]);
    expect(result.content!.parts![0].text!).toContain(
      'export const masked = 1;',
    );
  });

  it('skips files that can no longer be read from disk', async () => {
    const missing = path.join(tempDir, 'missing.ts');
    const result = await buildRecentFileReinjection(
      [makeRecord(missing, 1)],
      [],
      settings,
    );
    expect(result.content).toBeNull();
    expect(result.skippedMissingPaths).toEqual([missing]);
  });

  it('truncates a file that exceeds the per-file budget', async () => {
    const filePath = writeFile('big.ts', 'a'.repeat(9000));
    const result = await buildRecentFileReinjection(
      [makeRecord(filePath, 1)],
      [],
      { ...settings, maxTokensPerFile: 50 },
    );
    const text = result.content!.parts![0].text!;
    expect(result.truncated).toBe(true);
    expect(text).toContain(PER_FILE_TRUNCATION_MARKER);
    expect(text.length).toBeLessThan(9000);
  });

  it('truncates once the total budget is exhausted', async () => {
    const first = writeFile('first.ts', 'b'.repeat(300));
    const second = writeFile('second.ts', 'c'.repeat(300));
    const result = await buildRecentFileReinjection(
      [makeRecord(first, 2), makeRecord(second, 1)],
      [],
      { ...settings, maxTokensPerFile: 100_000, maxTokensTotal: 120 },
    );
    expect(result.truncated).toBe(true);
    expect(result.injectedPaths).toEqual([first, second]);
    const text = result.content!.parts![0].text!;
    expect(text).toContain(TOTAL_TRUNCATION_MARKER);
    expect(text).toContain('first.ts');
    expect(text).toContain('second.ts');
  });

  it('caps the number of injected files at maxFiles', async () => {
    const files = [
      writeFile('one.ts', 'export const one = 1;'),
      writeFile('two.ts', 'export const two = 2;'),
      writeFile('three.ts', 'export const three = 3;'),
    ];
    const result = await buildRecentFileReinjection(
      files.map((filePath, index) => makeRecord(filePath, index + 1)).reverse(),
      [],
      { ...settings, maxFiles: 2 },
    );
    expect(result.injectedPaths).toEqual([files[2], files[1]]);
    expect(result.content!.parts![0].text!).not.toContain('one.ts');
  });
});
