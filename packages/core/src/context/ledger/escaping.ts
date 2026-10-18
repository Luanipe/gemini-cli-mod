/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Escapes opening and closing occurrences of `tag` inside `body` (tolerating
 * whitespace after `<` or `/`) so untrusted content cannot close or spoof a
 * labelled container such as `<context_ledger>` or
 * `<recently_referenced_files>`.
 */
export function escapeLedgerTag(body: string, tag: string): string {
  const pattern = new RegExp(`<(\\/?)\\s*${tag}\\b[^>]*>`, 'gi');
  return body.replace(
    pattern,
    (_match, slash: string) => `&lt;${slash}${tag}&gt;`,
  );
}
