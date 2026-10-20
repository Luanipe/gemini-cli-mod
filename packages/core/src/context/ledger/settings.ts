/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_FILES_ADAPTER_SETTINGS,
  FILES_ADAPTER_ID,
} from './adapters/files.js';

/** Per-adapter budgets and enablement, keyed by adapter id. */
export interface LedgerAdapterSettings {
  /** When false, this adapter contributes nothing. */
  enabled: boolean;
  /** Maximum number of entries considered, most relevant first. */
  maxEntries?: number;
  /** Total token budget for this adapter's injected block. */
  maxTokens: number;
  /** Optional per-entry token budget (for example per file). */
  maxTokensPerEntry?: number;
  /** Marker prepended when an entry exceeds {@link maxTokensPerEntry}. */
  perEntryTruncationMarker?: string;
  /** Marker prepended when {@link maxTokens} is exhausted mid-block. */
  blockTruncationMarker?: string;
}

/** User-configurable settings for the context ledger. */
export interface LedgerSettings {
  /** Master switch. When false, nothing is injected. */
  enabled: boolean;
  /** Token budget shared across every adapter's block. */
  maxTokensTotal: number;
  /** Per-adapter settings keyed by adapter id. */
  adapters: Record<string, LedgerAdapterSettings>;
}

/** A user-supplied override; every field is optional. */
export interface PartialLedgerSettings {
  enabled?: boolean;
  maxTokensTotal?: number;
  adapters?: Record<string, Partial<LedgerAdapterSettings>>;
}

/**
 * Conservative defaults. The files adapter reproduces AH-3 and is enabled by
 * default; every other adapter is opt-in. With no new adapter enabled, the
 * ledger is a no-op beyond what AH-3 already injected.
 */
export const DEFAULT_LEDGER_SETTINGS: LedgerSettings = {
  enabled: true,
  maxTokensTotal: 80000,
  adapters: {
    [FILES_ADAPTER_ID]: { ...DEFAULT_FILES_ADAPTER_SETTINGS },
  },
};

/**
 * Merges partial user settings over the defaults, per adapter.
 */
export function resolveLedgerSettings(
  partial?: PartialLedgerSettings,
): LedgerSettings {
  const adapters = new Map<string, LedgerAdapterSettings>();
  for (const [id, defaults] of Object.entries(
    DEFAULT_LEDGER_SETTINGS.adapters,
  )) {
    adapters.set(id, { ...defaults, ...(partial?.adapters?.[id] ?? {}) });
  }
  // Keep any unknown adapters the caller supplied (future-proofing).
  for (const [id, settings] of Object.entries(partial?.adapters ?? {})) {
    if (!adapters.has(id)) {
      adapters.set(id, { enabled: false, maxTokens: 0, ...settings });
    }
  }
  return {
    enabled: partial?.enabled ?? DEFAULT_LEDGER_SETTINGS.enabled,
    maxTokensTotal:
      partial?.maxTokensTotal ?? DEFAULT_LEDGER_SETTINGS.maxTokensTotal,
    adapters: Object.fromEntries(adapters),
  };
}
