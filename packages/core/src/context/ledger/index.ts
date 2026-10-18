/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export * from './types.js';
export * from './settings.js';
export * from './registry.js';
export { ContextLedgerService } from './contextLedgerService.js';
export {
  FILES_ADAPTER_ID,
  RECENTLY_REFERENCED_FILES_TAG,
  PER_FILE_TRUNCATION_MARKER,
  FILES_BLOCK_TRUNCATION_MARKER,
  DEFAULT_FILES_ADAPTER_SETTINGS,
  createFilesAdapter,
} from './adapters/files.js';
