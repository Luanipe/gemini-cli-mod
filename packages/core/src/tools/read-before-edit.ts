/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ToolResult } from './tools.js';
import { ToolErrorType } from './tool-error.js';

/**
 * Enforces that the model has seen the current on-disk content of `filePath`
 * before it is allowed to write to or edit it.
 *
 * This guards against hallucinated changes built on content that was never
 * read, or that changed on disk (by the user, a linter, or another tool) since
 * it was last read. The check is a hard failure: the tool returns an error
 * result instead of applying the write, so the model must read the file again.
 *
 * @returns A failing {@link ToolResult} when the write must be blocked, or
 *   `null` when the write is allowed.
 */
export async function enforceReadBeforeEdit(
  config: Config,
  filePath: string,
): Promise<ToolResult | null> {
  // Defensive: some test doubles construct a partial Config. In production the
  // real Config always provides both of these.
  if (
    typeof config.isReadBeforeEditRequired !== 'function' ||
    typeof config.getFileReadState !== 'function'
  ) {
    return null;
  }

  if (!config.isReadBeforeEditRequired()) {
    return null;
  }

  const check = await config.getFileReadState().checkFreshness(filePath);

  switch (check.status) {
    case 'fresh':
    case 'new-file':
      return null;
    case 'not-read': {
      const message = `File has not been read yet. Read it first before writing to it: ${filePath}`;
      return {
        llmContent: message,
        returnDisplay: `File not read: ${filePath}`,
        error: { message, type: ToolErrorType.FILE_NOT_READ },
      };
    }
    case 'stale': {
      const message =
        `File has been modified since it was last read (by the user, a linter, ` +
        `or another tool). Read it again before writing to it: ${filePath}`;
      return {
        llmContent: message,
        returnDisplay: `File changed on disk: ${filePath}`,
        error: { message, type: ToolErrorType.FILE_STALE },
      };
    }
    default:
      return null;
  }
}
