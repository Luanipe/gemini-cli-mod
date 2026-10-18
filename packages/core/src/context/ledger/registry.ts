/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContextLedgerAdapter } from './types.js';
import { createFilesAdapter } from './adapters/files.js';

/**
 * Holds the registered ledger adapters and yields them in a deterministic
 * order (ascending adapter `order`, then id).
 */
export class ContextLedgerRegistry {
  private readonly adapters = new Map<string, ContextLedgerAdapter>();

  register(adapter: ContextLedgerAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Ledger adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  /** Returns a registered adapter by id. Intended for adapters and tests. */
  get(id: string): ContextLedgerAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ContextLedgerAdapter[] {
    return [...this.adapters.values()].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
  }
}

/** Registry with every adapter compiled into this build. */
export function createDefaultLedgerRegistry(): ContextLedgerRegistry {
  const registry = new ContextLedgerRegistry();
  registry.register(createFilesAdapter());
  return registry;
}
