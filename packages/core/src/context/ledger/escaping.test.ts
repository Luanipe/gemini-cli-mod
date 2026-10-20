/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { escapeLedgerTag } from './escaping.js';

describe('escapeLedgerTag', () => {
  it('escapes opening and closing tags', () => {
    expect(escapeLedgerTag('a <x> b </x> c', 'x')).toBe(
      'a &lt;x&gt; b &lt;/x&gt; c',
    );
  });

  it('escapes tags with attributes and whitespace variants', () => {
    expect(escapeLedgerTag('<x foo="1">y</ x >', 'x')).toBe(
      '&lt;x&gt;y&lt;/x&gt;',
    );
  });

  it('leaves tags that share a prefix untouched', () => {
    expect(escapeLedgerTag('<xy> and <x_1>', 'x')).toBe('<xy> and <x_1>');
  });

  it('neutralizes an unterminated tag fragment without eating following text', () => {
    expect(escapeLedgerTag('aaa <x bbb', 'x')).toBe('aaa &lt;x&gt; bbb');
    expect(escapeLedgerTag('aaa <x ', 'x')).toBe('aaa &lt;x&gt; ');
    expect(escapeLedgerTag('aaa <x', 'x')).toBe('aaa &lt;x&gt;');
    // A following container tag must survive a bare fragment.
    expect(escapeLedgerTag('<x </x>', 'x')).toBe('&lt;x&gt; &lt;/x&gt;');
  });

  it('treats the tag literally (regex metacharacters)', () => {
    expect(escapeLedgerTag('keep <axb> but escape <a.b>', 'a.b')).toBe(
      'keep <axb> but escape &lt;a.b&gt;',
    );
  });

  it('is case-insensitive', () => {
    expect(escapeLedgerTag('<X></x>', 'x')).toBe('&lt;x&gt;&lt;/x&gt;');
  });
});
