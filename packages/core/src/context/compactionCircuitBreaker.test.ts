/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  COOLDOWN_MS,
  CompactionCircuitBreaker,
  MAX_CONSECUTIVE_FAILURES,
  MIN_COOLDOWN_MS,
} from './compactionCircuitBreaker.js';

describe('CompactionCircuitBreaker', () => {
  let now: number;
  let breaker: CompactionCircuitBreaker;

  beforeEach(() => {
    now = 1_000_000;
    breaker = new CompactionCircuitBreaker(() => now);
  });

  it('starts closed and allows summarization', () => {
    expect(breaker.getState()).toBe('closed');
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.shouldAttempt()).toBe(true);
  });

  it('opens after a failure and blocks attempts during the cooldown', () => {
    breaker.recordFailure();

    expect(breaker.getState()).toBe('open');
    expect(breaker.getConsecutiveFailures()).toBe(1);
    expect(breaker.getCooldownMs()).toBe(MIN_COOLDOWN_MS);
    expect(breaker.shouldAttempt()).toBe(false);

    now += MIN_COOLDOWN_MS - 1;
    expect(breaker.shouldAttempt()).toBe(false);
  });

  it('moves to half-open after the cooldown elapses', () => {
    breaker.recordFailure();
    now += MIN_COOLDOWN_MS;

    expect(breaker.shouldAttempt()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  it('closes after a successful half-open retry', () => {
    breaker.recordFailure();
    now += MIN_COOLDOWN_MS;
    expect(breaker.shouldAttempt()).toBe(true);

    breaker.recordSuccess();

    expect(breaker.getState()).toBe('closed');
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.getCooldownMs()).toBe(0);
    expect(breaker.shouldAttempt()).toBe(true);
  });

  it('re-opens with a longer cooldown when a half-open retry fails', () => {
    breaker.recordFailure();
    now += MIN_COOLDOWN_MS;
    expect(breaker.shouldAttempt()).toBe(true);

    breaker.recordFailure();

    expect(breaker.getState()).toBe('open');
    expect(breaker.getConsecutiveFailures()).toBe(2);
    expect(breaker.getCooldownMs()).toBe(MIN_COOLDOWN_MS * 2);
    expect(breaker.shouldAttempt()).toBe(false);

    now += MIN_COOLDOWN_MS * 2;
    expect(breaker.shouldAttempt()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  it('uses the long cooldown once the failure cap is reached', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i += 1) {
      breaker.recordFailure();
    }

    expect(breaker.getConsecutiveFailures()).toBe(MAX_CONSECUTIVE_FAILURES);
    expect(breaker.getCooldownMs()).toBe(COOLDOWN_MS);

    now += COOLDOWN_MS - 1;
    expect(breaker.shouldAttempt()).toBe(false);

    now += 1;
    expect(breaker.shouldAttempt()).toBe(true);
    expect(breaker.getState()).toBe('half-open');
  });

  it('resets to the closed state', () => {
    breaker.recordFailure();
    breaker.reset();

    expect(breaker.getState()).toBe('closed');
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.shouldAttempt()).toBe(true);
  });
});
