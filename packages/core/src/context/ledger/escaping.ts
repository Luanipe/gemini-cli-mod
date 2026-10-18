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
 * keeps `<context_ledgerX>` untouched. A fragment without a closing `>` (such
 * as a trailing `<context_ledger`) is also neutralized but the match is bounded
 * so it never consumes the tag's following text or a subsequent container tag.
 */
export function escapeLedgerTag(body: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const replace = (_match: string, slash: string) => `&lt;${slash}${tag}&gt;`;

  // A complete tag: `<tag>`, `</tag>`, `<tag attr="v" />`, with whitespace.
  const complete = new RegExp(
    `<(/?)\\s*${escapedTag}(?:\\s+[^\\s=/><]+(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?)*\\s*/?>`,
    'gi',
  );
  // A bare fragment with no closing `>`, bounded so it cannot eat following
  // text (the negative lookahead keeps `<context_ledgerX>` untouched).
  const bare = new RegExp(`<(/?)\\s*${escapedTag}(?![\\w-])`, 'gi');

  return body.replace(complete, replace).replace(bare, replace);
}
