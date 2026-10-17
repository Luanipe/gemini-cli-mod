/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import * as fs from 'node:fs/promises';
import type { FileReadRecord } from '../utils/fileReadState.js';
import {
  estimateCharsFromTokens,
  truncateProportionally,
} from './truncation.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';

/** Tag wrapping the re-injected block. */
export const RECENTLY_REFERENCED_FILES_TAG = 'recently_referenced_files';

/** Marker prepended when a single file exceeds the per-file token budget. */
export const PER_FILE_TRUNCATION_MARKER =
  '[Re-injection truncated: file exceeds per-file token budget]';

/** Marker prepended when the total re-injection budget is exhausted. */
export const TOTAL_TRUNCATION_MARKER =
  '[Re-injection truncated: total token budget exhausted]';

/** Conservative defaults, overridable via `context.recentFileReinjection`. */
export const DEFAULT_RECENT_FILE_REINJECTION: RecentFileReinjectionSettings = {
  enabled: true,
  maxFiles: 10,
  maxTokensPerFile: 5000,
  maxTokensTotal: 50000,
};

/**
 * User-configurable budgets for post-compaction re-injection of recently
 * touched files (AH-3).
 */
export interface RecentFileReinjectionSettings {
  /** Master switch. When false, nothing is re-injected. */
  enabled: boolean;
  /** Maximum number of recently touched files considered. */
  maxFiles: number;
  /** Maximum tokens re-injected for a single file. */
  maxTokensPerFile: number;
  /** Maximum tokens re-injected across all files. */
  maxTokensTotal: number;
}

/** Outcome of building a re-injection block. */
export interface RecentFileReinjectionResult {
  /** The user turn to inject, or null when there was nothing to inject. */
  content: Content | null;
  /** Paths that were re-read from disk and injected. */
  injectedPaths: string[];
  /** Paths skipped because their content is still verbatim in the tail. */
  skippedPresentPaths: string[];
  /** Paths skipped because the file could no longer be read from disk. */
  skippedMissingPaths: string[];
  /** True when any file or the total budget was truncated. */
  truncated: boolean;
  /** Estimated tokens in the injected block. */
  estimatedTokens: number;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively collects string values from a function response so verbatim
 * content can be located in the preserved history. JSON stringification is not
 * used because it escapes newlines, which would defeat substring matching.
 */
function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 5 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, out, depth + 1);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const item of Object.values(value)) {
      collectStrings(item, out, depth + 1);
    }
  }
}

/**
 * Returns the text the model can still see in the preserved tail, normalized
 * so that line-ending differences do not defeat substring matching.
 */
function collectPreservedText(history: readonly Content[]): string {
  const chunks: string[] = [];
  for (const turn of history) {
    for (const part of turn.parts ?? []) {
      if (part.text) {
        chunks.push(part.text);
      }
      if (part.functionResponse?.response !== undefined) {
        collectStrings(part.functionResponse.response, chunks);
      }
    }
  }
  return normalizeLineEndings(chunks.join('\n'));
}

function formatBlock(
  entries: ReadonlyArray<{ path: string; content: string }>,
): string {
  const sections = entries
    .map((entry) => `### ${entry.path}\n\`\`\`\n${entry.content}\n\`\`\``)
    .join('\n\n');

  return `<${RECENTLY_REFERENCED_FILES_TAG}>
The following files were recently read or written in this session. Their
verbatim content was dropped from the conversation when the context was
compressed. The content below was re-read from disk at compaction time and is
provided as historical reference only — if a file may have changed, read it
again before editing.

${sections}
</${RECENTLY_REFERENCED_FILES_TAG}>`;
}

/**
 * Builds a `<recently_referenced_files>` user turn for the files the model most
 * recently touched, re-reading their current content from disk.
 *
 * Files whose content is still verbatim in `preservedHistory` are skipped, so
 * only content that was actually dropped is re-injected.
 */
export async function buildRecentFileReinjection(
  records: readonly FileReadRecord[],
  preservedHistory: readonly Content[],
  settings: RecentFileReinjectionSettings = DEFAULT_RECENT_FILE_REINJECTION,
): Promise<RecentFileReinjectionResult> {
  const result: RecentFileReinjectionResult = {
    content: null,
    injectedPaths: [],
    skippedPresentPaths: [],
    skippedMissingPaths: [],
    truncated: false,
    estimatedTokens: 0,
  };

  if (!settings.enabled || records.length === 0) {
    return result;
  }

  const preservedText = collectPreservedText(preservedHistory);
  const entries: Array<{ path: string; content: string }> = [];
  let usedTokens = 0;

  for (const record of records.slice(0, Math.max(0, settings.maxFiles))) {
    let raw: string;
    try {
      raw = await fs.readFile(record.path, 'utf8');
    } catch {
      result.skippedMissingPaths.push(record.path);
      continue;
    }

    let content = normalizeLineEndings(raw);
    if (content.trim().length === 0) {
      continue;
    }

    // Content still verbatim in the preserved tail: nothing to re-inject.
    if (preservedText.includes(content)) {
      result.skippedPresentPaths.push(record.path);
      continue;
    }

    // Per-file budget.
    if (
      estimateTokenCountSync([{ text: content }]) > settings.maxTokensPerFile
    ) {
      const targetChars = estimateCharsFromTokens(
        content,
        settings.maxTokensPerFile,
      );
      content = truncateProportionally(
        content,
        targetChars,
        PER_FILE_TRUNCATION_MARKER,
      );
      result.truncated = true;
    }

    // Total budget.
    const entryTokens = estimateTokenCountSync([{ text: content }]);
    if (usedTokens + entryTokens > settings.maxTokensTotal) {
      const remaining = settings.maxTokensTotal - usedTokens;
      if (remaining <= 0) {
        break;
      }
      const targetChars = estimateCharsFromTokens(content, remaining);
      content = truncateProportionally(
        content,
        targetChars,
        TOTAL_TRUNCATION_MARKER,
      );
      result.truncated = true;
      entries.push({ path: record.path, content });
      result.injectedPaths.push(record.path);
      usedTokens = settings.maxTokensTotal;
      break;
    }

    entries.push({ path: record.path, content });
    result.injectedPaths.push(record.path);
    usedTokens += entryTokens;
  }

  if (entries.length === 0) {
    return result;
  }

  const block = formatBlock(entries);
  result.content = { role: 'user', parts: [{ text: block }] };
  result.estimatedTokens = estimateTokenCountSync([{ text: block }]);
  return result;
}
