/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type { Config } from '../../config/config.js';
import type { LedgerAdapterSettings } from './settings.js';

/**
 * Whether an entry can be reproduced at compaction time.
 *
 * - `reference`: the source can be re-executed/re-fetched (`read_file`,
 *   `grep`, `read_mcp_resource(uri)`, `webfetch(url)`); the ledger may re-run it.
 * - `snapshot`: the source is not reproducible (user instructions, one-shot
 *   command output); the ledger carries the captured payload forward in memory.
 */
export type LedgerKind = 'reference' | 'snapshot';

/**
 * Whether an entry is authoritative or reference-only.
 *
 * - `authoritative`: the user's own instructions.
 * - `untrusted`: web / MCP / tool output. Must never be framed as instructions.
 */
export type LedgerTrust = 'authoritative' | 'untrusted';

/**
 * How the ledger decides whether an entry is already present in the preserved
 * tail.
 *
 * - `verbatim` (default): substring match. Safe for large, high-entropy
 *   payloads such as file contents; a short payload can match inside unrelated
 *   text and be dropped spuriously.
 * - `exact`: whole-part match. Use for short, low-entropy payloads (for example
 *   one-line user instructions) where a substring match is too aggressive.
 * - `never`: never skip. Use when the payload is assembled or transformed and
 *   cannot be compared verbatim against history.
 */
export type LedgerPresentCheck = 'verbatim' | 'exact' | 'never';

/** A single candidate re-injection entry produced by an adapter. */
export interface ContextLedgerEntry {
  /** Id of the adapter that produced the entry. */
  readonly adapterId: string;
  /** Adapter-scoped dedupe key (for example a file path or a normalized URL). */
  readonly key: string;
  readonly kind: LedgerKind;
  readonly trust: LedgerTrust;
  /** Ordering within the adapter, ascending (most recent first is `0`). */
  readonly order: number;
  /** Human-readable label rendered next to the content (path, url, tool...). */
  readonly label: string;
  /** Full resolved content for the entry (never an LLM summary). */
  readonly content: string;
}

/** A ledger entry after the service resolved it against the configured budgets. */
export interface ResolvedLedgerEntry {
  readonly entry: ContextLedgerEntry;
  /** Content after per-entry and per-adapter budgets were applied. */
  readonly content: string;
  /** Estimated tokens for {@link content}. */
  readonly tokens: number;
  /** True when one of the budgets truncated this entry. */
  readonly truncated: boolean;
}

/** Context handed to {@link ContextLedgerAdapter.collect}. */
export interface LedgerAdapterContext {
  readonly config: Config;
  /** History that survives this compaction; used to skip already-present content. */
  readonly preservedHistory: readonly Content[];
  /** Resolved settings for this adapter (budgets, enablement). */
  readonly settings: LedgerAdapterSettings;
}

/**
 * A pluggable source of content that can be re-injected after compaction.
 *
 * The adapter owns how its own source is collected and rendered; the central
 * {@link ContextLedgerService} owns budgets, dedupe, ordering and placement.
 */
export interface ContextLedgerAdapter {
  /** Stable id, also used as the settings key (`context.ledger.adapters.<id>`). */
  readonly id: string;
  readonly kind: LedgerKind;
  readonly trust: LedgerTrust;
  /** Ordering across adapters, ascending. */
  readonly order: number;
  /**
   * When `true`, the adapter's {@link serialize} output already carries an
   * explicit historical-reference disclaimer, so the ledger does not add an
   * untrusted/authoritative wrapper. Untrusted adapters should default to
   * `false` so a forgotten disclaimer is still delimited centrally.
   */
  readonly selfLabelsTrust?: boolean;
  /**
   * How to decide whether {@link collect} content is still present in the
   * preserved tail. Defaults to `verbatim`; see {@link LedgerPresentCheck}.
   */
  readonly skipPresent?: LedgerPresentCheck;
  /**
   * Collects candidate entries. Content must be resolved, never summarized; it
   * is rendered verbatim except that ledger container tags are neutralized
   * (escaped) so content cannot close or spoof a block.
   *
   * The ledger skips an entry whose `content` is still present in the preserved
   * tail, using the adapter's {@link skipPresent} strategy. `content` must be
   * verbatim for the default substring check to work; short, low-entropy
   * payloads should use `exact` or `never` instead.
   */
  collect(ctx: LedgerAdapterContext): Promise<ContextLedgerEntry[]>;
  /** Renders this adapter's labelled block from the entries the service kept. */
  serialize(entries: readonly ResolvedLedgerEntry[]): string;
}

/** Outcome of a ledger build. */
export interface ContextLedgerBuildResult {
  /** The user turn to inject, or `null` when nothing was injected. */
  content: Content | null;
  /** Keys (`adapterId:key`) that were injected this build. */
  injectedKeys: string[];
  /** Keys skipped because their content is still verbatim in the tail. */
  skippedPresentKeys: string[];
  /**
   * True when a per-entry or per-adapter budget truncated output, or when the
   * central budget (or a zero remaining adapter budget) dropped a block.
   */
  truncated: boolean;
  /** Estimated tokens in the injected block. */
  estimatedTokens: number;
}
