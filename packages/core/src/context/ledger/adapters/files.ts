/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type {
  ContextLedgerAdapter,
  ContextLedgerEntry,
  ResolvedLedgerEntry,
} from '../types.js';
import type { LedgerAdapterSettings } from '../settings.js';
import { normalizeLineEndings } from '../preservedText.js';

/** Id used as the settings key: `context.ledger.adapters.files`. */
export const FILES_ADAPTER_ID = 'files';

/** Tag wrapping the re-injected files block. */
export const RECENTLY_REFERENCED_FILES_TAG = 'recently_referenced_files';

/** Marker prepended when a single file exceeds the per-file token budget. */
export const PER_FILE_TRUNCATION_MARKER =
  '[Re-injection truncated: file exceeds per-file token budget]';

/** Marker prepended when the files-adapter block budget is exhausted. */
export const FILES_BLOCK_TRUNCATION_MARKER =
  '[Re-injection truncated: total token budget exhausted]';

/** Conservative defaults for the files adapter, overridable via settings. */
export const DEFAULT_FILES_ADAPTER_SETTINGS: LedgerAdapterSettings = {
  enabled: true,
  maxEntries: 10,
  maxTokens: 50000,
  maxTokensPerEntry: 5000,
  perEntryTruncationMarker: PER_FILE_TRUNCATION_MARKER,
  blockTruncationMarker: FILES_BLOCK_TRUNCATION_MARKER,
};

const FILES_BLOCK_PREAMBLE = `The following files were recently read or written in this session. Their
verbatim content was dropped from the conversation when the context was
compressed. The content below was re-read from disk at compaction time and is
provided as historical reference only — if a file may have changed, read it
again before editing.`;

function formatBlock(entries: readonly ResolvedLedgerEntry[]): string {
  const sections = entries
    .map(
      (entry) => `### ${entry.entry.label}\n\`\`\`\n${entry.content}\n\`\`\``,
    )
    .join('\n\n');

  return `<${RECENTLY_REFERENCED_FILES_TAG}>
${FILES_BLOCK_PREAMBLE}

${sections}
</${RECENTLY_REFERENCED_FILES_TAG}>`;
}

/**
 * Re-injects files the model recently touched, re-read from disk at compaction
 * time (the generalised form of AH-3). The block self-labels as historical
 * reference, so the ledger does not add an untrusted wrapper around it.
 */
export function createFilesAdapter(): ContextLedgerAdapter {
  return {
    id: FILES_ADAPTER_ID,
    kind: 'reference',
    trust: 'untrusted',
    order: 0,
    selfLabelsTrust: true,
    async collect({ config, settings }): Promise<ContextLedgerEntry[]> {
      const tracker = config.getFileReadState?.();
      if (!tracker) {
        return [];
      }
      // `undefined` means unlimited, matching the ledger settings and the
      // service's own slice; read only as many records as will be considered.
      const limit = settings.maxEntries ?? Number.POSITIVE_INFINITY;
      const records = tracker.recentlyTouched(limit);
      const entries: ContextLedgerEntry[] = [];
      for (const [index, record] of records.entries()) {
        let raw: string;
        try {
          raw = await fs.readFile(record.path, 'utf8');
        } catch {
          // Best-effort: a file that can no longer be read is skipped.
          continue;
        }
        const content = normalizeLineEndings(raw);
        if (content.trim().length === 0) {
          continue;
        }
        entries.push({
          adapterId: FILES_ADAPTER_ID,
          key: record.path,
          kind: 'reference',
          trust: 'untrusted',
          order: index,
          label: record.path,
          content,
        });
      }
      return entries;
    },
    serialize(entries: readonly ResolvedLedgerEntry[]): string {
      return formatBlock(entries);
    },
  };
}
