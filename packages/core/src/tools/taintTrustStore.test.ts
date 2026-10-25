/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  areCommandsTrustedForSession,
  resetTaintTrust,
  trustCommandsForSession,
} from './taintTrustStore.js';

describe('taintTrustStore', () => {
  it('returns false when nothing has been trusted', () => {
    const session = {};
    expect(areCommandsTrustedForSession(session, ['rg'])).toBe(false);
  });

  it('trusts the given root commands for the session', () => {
    const session = {};
    trustCommandsForSession(session, ['rg']);
    expect(areCommandsTrustedForSession(session, ['rg'])).toBe(true);
    expect(areCommandsTrustedForSession(session, ['git'])).toBe(false);
  });

  it('requires every root command to be trusted', () => {
    const session = {};
    trustCommandsForSession(session, ['rg']);
    expect(areCommandsTrustedForSession(session, ['rg', 'git'])).toBe(false);

    trustCommandsForSession(session, ['git']);
    expect(areCommandsTrustedForSession(session, ['rg', 'git'])).toBe(true);
  });

  it('resets trust for a session', () => {
    const session = {};
    trustCommandsForSession(session, ['rg']);
    resetTaintTrust(session);
    expect(areCommandsTrustedForSession(session, ['rg'])).toBe(false);
  });

  it('ignores empty root lists', () => {
    const session = {};
    trustCommandsForSession(session, []);
    expect(areCommandsTrustedForSession(session, [])).toBe(false);
  });

  it('isolates different sessions', () => {
    const sessionA = {};
    const sessionB = {};
    trustCommandsForSession(sessionA, ['rg']);
    expect(areCommandsTrustedForSession(sessionA, ['rg'])).toBe(true);
    expect(areCommandsTrustedForSession(sessionB, ['rg'])).toBe(false);
  });

  it('does not conflate a local path with the bare command name', () => {
    const session = {};
    trustCommandsForSession(session, ['./rg']);
    expect(areCommandsTrustedForSession(session, ['./rg'])).toBe(true);
    expect(areCommandsTrustedForSession(session, ['rg'])).toBe(false);
  });
});
