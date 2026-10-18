/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Escapes opening and closing occurrences of `tag` inside `body` (tolerating
 * whitespace after `<` or `/`, and matching attributes) so untrusted content
 * cannot close or spoof a labelled container such as `<context_ledger>` or
 * `<recently_referenced_files>`.
 *
 * `tag` is treated literally (regex metacharacters are escaped). A lookahead
 * keeps `<context_ledgerX>` untouched, and an unterminated fragment such as
 * `<context_ledger` is still neutralized.
 */
export function escapeLedgerTag(body: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<(\\/?)\\s*${escapedTag}(?=[\\s/>])[^>]*>?`,
    'gi',
  );
  return body.replace(
    pattern,
    (_match, slash: string) => `&lt;${slash}${tag}&gt;`,
  );
}
