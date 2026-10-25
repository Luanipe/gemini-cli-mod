/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-scoped trust for shell commands whose arguments were flagged as
 * sourced from untrusted context.
 *
 * Trust is keyed by the session object (the `Config` instance) so it lives
 * exactly as long as the session. It is intentionally in-memory only: it must
 * never be written to policy TOML or survive a new session.
 */
const SESSION_TRUST = new WeakMap<object, Set<string>>();

function normalizeTrustKey(root: string): string {
  const normalized = root.trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Records that the given root commands may skip untrusted-flag prompts for the
 * remainder of the session.
 */
export function trustCommandsForSession(
  sessionKey: object,
  roots: readonly string[],
): void {
  if (roots.length === 0) {
    return;
  }

  const trusted = SESSION_TRUST.get(sessionKey) ?? new Set<string>();
  for (const root of roots) {
    const key = normalizeTrustKey(root);
    if (key) {
      trusted.add(key);
    }
  }

  if (trusted.size > 0) {
    SESSION_TRUST.set(sessionKey, trusted);
  }
}

/**
 * Returns true when every root command in the invocation has been trusted for
 * this session.
 */
export function areCommandsTrustedForSession(
  sessionKey: object,
  roots: readonly string[],
): boolean {
  if (roots.length === 0) {
    return false;
  }

  const trusted = SESSION_TRUST.get(sessionKey);
  if (!trusted) {
    return false;
  }

  return roots.every((root) => trusted.has(normalizeTrustKey(root)));
}

/**
 * Clears all untrusted-flag trust for the session. Called when a new session
 * starts (`/clear`, resume, or a session-id rotation).
 */
export function resetTaintTrust(sessionKey: object): void {
  SESSION_TRUST.delete(sessionKey);
}
