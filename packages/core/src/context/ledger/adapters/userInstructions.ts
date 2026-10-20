/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { createHash } from 'node:crypto';
import type {
  ContextLedgerAdapter,
  ContextLedgerEntry,
  LedgerAdapterContext,
  ResolvedLedgerEntry,
} from '../types.js';
import type { LedgerAdapterSettings } from '../settings.js';
import { normalizeLineEndings } from '../preservedText.js';
import { escapeLedgerTag } from '../escaping.js';

/** Id used as the settings key: `context.ledger.adapters.userInstructions`. */
export const USER_INSTRUCTIONS_ADAPTER_ID = 'userInstructions';

/** Tag wrapping the re-injected user instruction log. */
export const USER_INSTRUCTION_LOG_TAG = 'user_instruction_log';

/** Marker prepended when a single instruction exceeds the per-entry budget. */
export const PER_INSTRUCTION_TRUNCATION_MARKER =
  '[Re-injection truncated: user instruction exceeds per-entry token budget]';

/** Marker prepended when the instruction-log budget is exhausted. */
export const USER_INSTRUCTIONS_BLOCK_TRUNCATION_MARKER =
  '[Re-injection truncated: user instruction log token budget exhausted]';

/**
 * Conservative defaults. The instruction log is opt-in (like every adapter
 * other than `files`) because it re-injects authoritative text and costs
 * tokens on every compaction.
 */
export const DEFAULT_USER_INSTRUCTIONS_ADAPTER_SETTINGS: LedgerAdapterSettings =
  {
    enabled: false,
    maxEntries: 100,
    maxTokens: 12000,
    maxTokensPerEntry: 2000,
    perEntryTruncationMarker: PER_INSTRUCTION_TRUNCATION_MARKER,
    blockTruncationMarker: USER_INSTRUCTIONS_BLOCK_TRUNCATION_MARKER,
  };

/**
 * Container tags that identify machine-generated content using the `user` role.
 * They are checked at the start of a part (after an optional `---` separator),
 * so a genuine prompt that merely quotes a tag mid-sentence is preserved.
 */
const NON_INSTRUCTION_TAG_PREFIXES = [
  '<session_context>',
  '<context_ledger',
  `<${USER_INSTRUCTION_LOG_TAG}`,
  '<recently_referenced_files>',
  '<loaded_context>',
  '<project_context>',
  '<extension_context>',
  '<global_context>',
  '<hook_context>',
  '<background_output>',
] as const;

/**
 * Markers that may appear after another wrapper (a scratchpad-prefixed summary)
 * or that do not start the part. These are checked anywhere in the text.
 */
const NON_INSTRUCTION_MARKERS = [
  '<state_snapshot',
  '<scratchpad',
  // Shared by every local-executor final-warning variant, including
  // ERROR_NO_COMPLETE_TASK_CALL, whose prose does not start with "You have
  // exceeded".
  'You have one final chance to complete the task',
] as const;

/** Machine-generated prose that carries no tag. */
const NON_INSTRUCTION_PREFIXES = [
  "Here is the user's editor context",
  'User hints:',
  'User hint:',
  'User steering update:',
  'Background execution update:',
  '- **Workspace Directories:**',
  'You have exceeded the',
  'You have stopped calling tools without finishing.',
  '[Continuing from previous AI thoughts...]',
  'The tool execution result was lost due to context management truncation.',
] as const;

function isUserInstructionText(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length === 0) {
    return false;
  }
  // Some context blocks are preceded by a markdown separator.
  const withoutSeparator = trimmed.replace(/^---\s*/, '');
  if (
    NON_INSTRUCTION_TAG_PREFIXES.some((prefix) =>
      withoutSeparator.startsWith(prefix),
    )
  ) {
    return false;
  }
  if (NON_INSTRUCTION_MARKERS.some((marker) => text.includes(marker))) {
    return false;
  }
  return !NON_INSTRUCTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Extracts the user-authored text from the segment a compaction is dropping.
 *
 * Only `user` turns made of plain text qualify. Tool results (`functionResponse`
 * parts), model turns, and the machine-generated blocks above are excluded. A
 * multi-part turn keeps only its instruction-looking parts, joined into one
 * request. The text is returned verbatim, in chronological order.
 */
export function collectUserInstructions(
  droppedHistory: readonly Content[],
): string[] {
  const instructions: string[] = [];
  for (const turn of droppedHistory) {
    if (turn.role !== 'user') {
      continue;
    }
    const parts = turn.parts ?? [];
    // A user-role message carrying a function response is tool output, not a
    // prompt. Tool results must never be re-injected as user instructions.
    if (parts.some((part) => part.functionResponse)) {
      continue;
    }
    const texts = parts
      .map((part) => part.text)
      .filter(
        (text): text is string =>
          typeof text === 'string' && isUserInstructionText(text),
      );
    if (texts.length === 0) {
      continue;
    }
    instructions.push(texts.join('\n\n'));
  }
  return instructions;
}

function requestNumber(entry: ResolvedLedgerEntry, fallback: number): number {
  const number = -entry.entry.order;
  return number > 0 ? number : fallback;
}

/**
 * Stable per-content key. If a compaction attempt fails after the ledger was
 * built, the same dropped history is collected again on the next attempt; a
 * content-derived key makes the service overwrite the earlier snapshot instead
 * of injecting it twice. The occurrence index keeps genuinely repeated
 * instructions distinct within one batch.
 */
function instructionKey(content: string, occurrence: number): string {
  const digest = createHash('sha256')
    .update(content)
    .digest('hex')
    .slice(0, 16);
  return `instruction-${digest}-${occurrence}`;
}

function formatLog(entries: readonly ResolvedLedgerEntry[]): string {
  // The adapter assigns newer requests a smaller (more negative) `order` so
  // that the service's `maxEntries` keeps the most recent ones. Rendering is
  // chronological, so sort by descending order before numbering.
  const chronological = [...entries].sort(
    (a, b) => b.entry.order - a.entry.order,
  );
  const body = chronological
    .map((entry, index) => {
      const number = requestNumber(entry, index + 1);
      const text = escapeLedgerTag(entry.content, USER_INSTRUCTION_LOG_TAG);
      return `### Request ${number}\n${text}`;
    })
    .join('\n\n');

  return `<${USER_INSTRUCTION_LOG_TAG}>
${body}
</${USER_INSTRUCTION_LOG_TAG}>`;
}

/**
 * Preserves the user's earlier requests verbatim across compaction (AH-4).
 *
 * The service wraps the block in its `authoritative` trust container, so the
 * log is always presented as a historical record and never as new
 * instructions. Entries are snapshots: they cannot be re-collected once the
 * compaction has completed, so the service carries them in memory.
 */
export function createUserInstructionsAdapter(): ContextLedgerAdapter {
  // Monotonic across builds so instructions collected by later compactions sort
  // after (are more recent than) the ones already carried forward. Newer
  // requests get a smaller order, matching the ledger's "most recent first"
  // retention semantics.
  let sequence = 0;
  // A key that is collected again (retry after a failed compaction) keeps its
  // original order and number instead of jumping to the end. Session-scoped:
  // cleared by reset() and bounded by the number of distinct instructions.
  const orders = new Map<string, number>();

  return {
    id: USER_INSTRUCTIONS_ADAPTER_ID,
    kind: 'snapshot',
    trust: 'authoritative',
    order: 10,
    // The service's authoritative wrapper supplies the "historical record, not
    // a new instruction" disclaimer.
    selfLabelsTrust: false,
    // Instructions are short, low-entropy payloads: a substring match would
    // drop them spuriously, so compare whole preserved parts.
    skipPresent: 'exact',
    reset(): void {
      sequence = 0;
      orders.clear();
    },
    async collect({
      droppedHistory,
    }: LedgerAdapterContext): Promise<ContextLedgerEntry[]> {
      const occurrences = new Map<string, number>();
      return collectUserInstructions(droppedHistory).map((text) => {
        const content = normalizeLineEndings(text);
        const occurrence = (occurrences.get(content) ?? 0) + 1;
        occurrences.set(content, occurrence);
        const key = instructionKey(content, occurrence);
        let order = orders.get(key);
        if (order === undefined) {
          sequence += 1;
          order = -sequence;
          orders.set(key, order);
        }
        return {
          adapterId: USER_INSTRUCTIONS_ADAPTER_ID,
          key,
          kind: 'snapshot',
          trust: 'authoritative',
          order,
          label: `request-${-order}`,
          content,
        };
      });
    },
    serialize(entries: readonly ResolvedLedgerEntry[]): string {
      return formatLog(entries);
    },
  };
}
