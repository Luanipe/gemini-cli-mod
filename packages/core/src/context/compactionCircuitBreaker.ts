/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type CompactionCircuitState = 'closed' | 'open' | 'half-open';

/** Hard ceiling for the cooldown once the breaker has tripped repeatedly. */
export const COOLDOWN_MS = 5 * 60 * 1000;

/** Base cooldown used for the first failures, doubled per consecutive failure. */
export const MIN_COOLDOWN_MS = 10 * 1000;

/** After this many consecutive failures the breaker uses the long cooldown. */
export const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Time-based circuit breaker for chat compaction.
 *
 * Summarization is the expensive, failure-prone half of compaction. Once it
 * fails we keep compacting, but only by truncating history, until a cooldown
 * elapses. The next attempt after the cooldown is a half-open probe: a success
 * closes the breaker, while another failure re-opens it with a longer cooldown.
 *
 * `shouldAttempt()` stays true in the half-open state so callers that end up
 * doing no summarization (for example because the history is under the
 * threshold) do not leave the breaker stuck without an outcome to record.
 */
export class CompactionCircuitBreaker {
  private state: CompactionCircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private cooldownMs = 0;

  constructor(private readonly now: () => number = Date.now) {}

  getState(): CompactionCircuitState {
    return this.state;
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /** The cooldown currently applied while the breaker is open. */
  getCooldownMs(): number {
    return this.cooldownMs;
  }

  /**
   * Returns whether summarization may be attempted now. Moves an expired
   * `open` breaker into `half-open` so the next outcome can close it.
   */
  shouldAttempt(): boolean {
    if (this.state === 'closed' || this.state === 'half-open') {
      return true;
    }

    if (this.now() - this.openedAt < this.cooldownMs) {
      return false;
    }

    this.state = 'half-open';
    return true;
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.cooldownMs = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    this.cooldownMs = this.computeCooldown(this.consecutiveFailures);
    this.openedAt = this.now();
    this.state = 'open';
  }

  /** Returns the breaker to its initial state, for a new session. */
  reset(): void {
    this.recordSuccess();
  }

  private computeCooldown(consecutiveFailures: number): number {
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return COOLDOWN_MS;
    }

    return Math.min(
      COOLDOWN_MS,
      MIN_COOLDOWN_MS * 2 ** (consecutiveFailures - 1),
    );
  }
}
