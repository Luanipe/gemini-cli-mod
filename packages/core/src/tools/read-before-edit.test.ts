/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { FileReadStateTracker } from '../utils/fileReadState.js';
import { enforceReadBeforeEdit } from './read-before-edit.js';
import { ToolErrorType } from './tool-error.js';

describe('enforceReadBeforeEdit', () => {
  let tmpDir: string;
  let tracker: FileReadStateTracker;

  function makeConfig(requireRead = true): Config {
    return {
      isReadBeforeEditRequired: () => requireRead,
      getFileReadState: () => tracker,
    } as unknown as Config;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbe-'));
    tracker = new FileReadStateTracker();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const p = (name: string) => path.join(tmpDir, name);

  it('allows creating a brand new file', async () => {
    const result = await enforceReadBeforeEdit(makeConfig(), p('new.ts'));
    expect(result).toBeNull();
  });

  it('blocks writing to an existing, never-read file', async () => {
    const file = p('existing.ts');
    await fs.writeFile(file, 'hello');
    const result = await enforceReadBeforeEdit(makeConfig(), file);
    expect(result).not.toBeNull();
    expect(result?.error?.type).toBe(ToolErrorType.FILE_NOT_READ);
    expect(result?.llmContent).toContain('has not been read');
  });

  it('blocks writing to a file changed since it was read', async () => {
    const file = p('changed.ts');
    await fs.writeFile(file, 'v1');
    await tracker.recordRead(file, 'v1');
    await fs.writeFile(file, 'v2');
    const result = await enforceReadBeforeEdit(makeConfig(), file);
    expect(result).not.toBeNull();
    expect(result?.error?.type).toBe(ToolErrorType.FILE_STALE);
    expect(result?.llmContent).toContain('modified since');
  });

  it('allows writing to a freshly read file', async () => {
    const file = p('fresh.ts');
    await fs.writeFile(file, 'content');
    await tracker.recordRead(file, 'content');
    const result = await enforceReadBeforeEdit(makeConfig(), file);
    expect(result).toBeNull();
  });

  it('skips the check when disabled', async () => {
    const file = p('disabled.ts');
    await fs.writeFile(file, 'hello');
    const result = await enforceReadBeforeEdit(makeConfig(false), file);
    expect(result).toBeNull();
  });

  it('skips the check for a partial config without the tracker', async () => {
    const file = p('partial.ts');
    await fs.writeFile(file, 'hello');
    const result = await enforceReadBeforeEdit({} as Config, file);
    expect(result).toBeNull();
  });
});
