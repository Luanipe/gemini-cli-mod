/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';

/** Normalizes CRLF/CR to LF so line-ending differences do not defeat matching. */
export function normalizeLineEndings(text: string): string {
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
 * Returns the text the model can still see in the preserved tail as individual
 * chunks, normalized so that line-ending differences do not defeat matching.
 *
 * Chunks keep message/part boundaries so an adapter can opt into whole-part
 * (`exact`) presence checks instead of substring matching.
 */
export function collectPreservedChunks(history: readonly Content[]): string[] {
  const chunks: string[] = [];
  for (const turn of history) {
    for (const part of turn.parts ?? []) {
      if (part.text) {
        chunks.push(normalizeLineEndings(part.text));
      }
      if (part.functionResponse?.response !== undefined) {
        const strings: string[] = [];
        collectStrings(part.functionResponse.response, strings);
        chunks.push(...strings.map(normalizeLineEndings));
      }
    }
  }
  return chunks;
}
