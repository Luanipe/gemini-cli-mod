/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../../../config/config.js';
import { ContextLedgerService } from '../contextLedgerService.js';
import { ContextLedgerRegistry } from '../registry.js';
import { resolveLedgerSettings, type LedgerSettings } from '../settings.js';
import {
  collectUserInstructions,
  createUserInstructionsAdapter,
  PER_INSTRUCTION_TRUNCATION_MARKER,
  USER_INSTRUCTION_LOG_TAG,
  USER_INSTRUCTIONS_ADAPTER_ID,
  USER_INSTRUCTIONS_BLOCK_TRUNCATION_MARKER,
} from './userInstructions.js';

function user(text: string): Content {
  return { role: 'user', parts: [{ text }] };
}

function model(text: string): Content {
  return { role: 'model', parts: [{ text }] };
}

function toolResponse(): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: { name: 'read_file', response: { output: 'secret' } },
      },
    ],
  };
}

function textOf(content: Content | null): string {
  return (content?.parts ?? []).map((part) => part.text ?? '').join('');
}

describe('user instructions ledger adapter', () => {
  let settings: LedgerSettings;

  beforeEach(() => {
    settings = resolveLedgerSettings({
      adapters: {
        [USER_INSTRUCTIONS_ADAPTER_ID]: {
          enabled: true,
          maxEntries: 100,
          maxTokens: 12_000,
          maxTokensPerEntry: 2_000,
        },
      },
    });
  });

  function makeConfig(): Config {
    return {
      getLedgerSettings: () => settings,
    } as unknown as Config;
  }

  function makeService(): ContextLedgerService {
    const registry = new ContextLedgerRegistry();
    registry.register(createUserInstructionsAdapter());
    return new ContextLedgerService(registry);
  }

  it('is opt-in: the default settings inject nothing', async () => {
    settings = resolveLedgerSettings();
    const result = await makeService().build(
      makeConfig(),
      [],
      [user('remember the API key is read from env')],
    );
    expect(result.content).toBeNull();
  });

  it('collects only plain user text, in chronological order', () => {
    const dropped: Content[] = [
      user('<session_context>environment</session_context>'),
      model('a model answer'),
      toolResponse(),
      user(
        '<scratchpad>reasoning</scratchpad>\n<state_snapshot>summary</state_snapshot>',
      ),
      user('<context_ledger adapter="files">old ledger</context_ledger>'),
      user('<recently_referenced_files>old files</recently_referenced_files>'),
      user('<loaded_context>project memory</loaded_context>'),
      user('User hints:\n<user_input>- focus</user_input>'),
      user(
        'Background execution update:\n<background_output>raw</background_output>',
      ),
      user(
        "Here is the user's editor context as a JSON object. This is for your information only.\n```json\n{}\n```",
      ),
      user('- **Workspace Directories:**\n  - /tmp'),
      user('You have exceeded the time limit.'),
      user('You have exceeded the maximum number of turns.'),
      user(
        'You have stopped calling tools without finishing. You have one final chance to complete the task with a short grace period.',
      ),
      user('---\n\n<loaded_context>project memory</loaded_context>'),
      user('<hook_context>hook output</hook_context>'),
      user('first request'),
      user('  '),
      user('second request'),
    ];

    expect(collectUserInstructions(dropped)).toEqual([
      'first request',
      'second request',
    ]);
  });

  it('keeps the instruction-looking parts of a multi-part turn as one request', () => {
    const dropped: Content[] = [
      {
        role: 'user',
        parts: [
          { text: '<loaded_context>project memory</loaded_context>' },
          { text: 'User hints:\n<user_input>- focus</user_input>' },
          { text: 'the actual task' },
        ],
      },
    ];

    expect(collectUserInstructions(dropped)).toEqual(['the actual task']);
  });

  it('keeps a genuine prompt that quotes a context tag mid-sentence', () => {
    expect(
      collectUserInstructions([
        user('Why is `<project_context>` empty in this session?'),
      ]),
    ).toEqual(['Why is `<project_context>` empty in this session?']);
  });

  it('renders an authoritative, chronological numbered log', async () => {
    const result = await makeService().build(
      makeConfig(),
      [],
      [user('first request'), user('second request')],
    );
    const text = textOf(result.content);

    expect(text).toContain('<context_ledger adapter="userInstructions"');
    expect(text).toContain('trust="authoritative"');
    expect(text).toContain('not a new instruction');
    expect(text).toContain(`<${USER_INSTRUCTION_LOG_TAG}>`);
    expect(text).toContain('### Request 1\nfirst request');
    expect(text).toContain('### Request 2\nsecond request');
    expect(text.indexOf('first request')).toBeLessThan(
      text.indexOf('second request'),
    );
  });

  it('carries instructions across compactions without duplicating them', async () => {
    const service = makeService();
    const config = makeConfig();

    const first = await service.build(
      makeConfig(),
      [],
      [user('request one'), user('request two')],
    );
    expect(textOf(first.content)).toContain('request one');
    expect(textOf(first.content)).toContain('request two');

    const second = await service.build(config, [], [user('request three')]);
    const text = textOf(second.content);

    expect(text).toContain('request one');
    expect(text).toContain('request two');
    expect(text).toContain('request three');
    expect(text.match(/request one/g)).toHaveLength(1);
    expect(text.match(/request two/g)).toHaveLength(1);
    expect(text.match(/request three/g)).toHaveLength(1);
    expect(text.indexOf('request one')).toBeLessThan(
      text.indexOf('request two'),
    );
    expect(text.indexOf('request two')).toBeLessThan(
      text.indexOf('request three'),
    );
  });

  it('keeps the most recent instructions when maxEntries is exceeded', async () => {
    settings = resolveLedgerSettings({
      adapters: {
        [USER_INSTRUCTIONS_ADAPTER_ID]: {
          enabled: true,
          maxEntries: 2,
          maxTokens: 12_000,
        },
      },
    });

    const result = await makeService().build(
      makeConfig(),
      [],
      [user('request one'), user('request two'), user('request three')],
    );
    const text = textOf(result.content);

    expect(text).not.toContain('request one');
    expect(text).toContain('### Request 2\nrequest two');
    expect(text).toContain('### Request 3\nrequest three');
    expect(text.indexOf('request two')).toBeLessThan(
      text.indexOf('request three'),
    );
  });

  it('skips an instruction still present in the preserved tail', async () => {
    const result = await makeService().build(
      makeConfig(),
      [user('still visible')],
      [user('still visible'), user('dropped')],
    );
    const text = textOf(result.content);

    expect(text).not.toContain('still visible');
    expect(text).toContain('dropped');
    expect(result.skippedPresentKeys).toHaveLength(1);
    expect(result.skippedPresentKeys[0]).toMatch(
      new RegExp(`^${USER_INSTRUCTIONS_ADAPTER_ID}:instruction-`),
    );
  });

  it('deduplicates when the same dropped history is collected again', async () => {
    // A failed compaction leaves the history unchanged; the next attempt builds
    // the ledger from the same dropped segment.
    const service = makeService();
    const config = makeConfig();
    const dropped = [user('request one'), user('request two')];

    await service.build(config, [], dropped);
    const second = await service.build(config, [], dropped);
    const text = textOf(second.content);

    expect(text.match(/request one/g)).toHaveLength(1);
    expect(text.match(/request two/g)).toHaveLength(1);
    // The retry keeps the original order and numbering.
    expect(text).toContain('### Request 1\nrequest one');
    expect(text).toContain('### Request 2\nrequest two');
    expect(text.indexOf('request one')).toBeLessThan(
      text.indexOf('request two'),
    );
  });

  it('restarts numbering when the ledger is reset', async () => {
    const service = makeService();
    const config = makeConfig();

    await service.build(config, [], [user('old request')]);
    service.reset();
    const result = await service.build(config, [], [user('new request')]);
    const text = textOf(result.content);

    expect(text).toContain('### Request 1\nnew request');
    expect(text).not.toContain('old request');
  });

  it('keeps genuinely repeated instructions distinct within one batch', async () => {
    const result = await makeService().build(
      makeConfig(),
      [],
      [user('deploy now'), user('deploy now')],
    );
    const text = textOf(result.content);

    expect(text.match(/deploy now/g)).toHaveLength(2);
    expect(text).toContain('### Request 1\ndeploy now');
    expect(text).toContain('### Request 2\ndeploy now');
  });

  it('truncates a single long instruction with an explicit marker', async () => {
    settings = resolveLedgerSettings({
      adapters: {
        [USER_INSTRUCTIONS_ADAPTER_ID]: {
          enabled: true,
          maxTokens: 12_000,
          maxTokensPerEntry: 20,
        },
      },
    });

    const result = await makeService().build(
      makeConfig(),
      [],
      [user('x'.repeat(5_000))],
    );
    const text = textOf(result.content);

    expect(text).toContain(PER_INSTRUCTION_TRUNCATION_MARKER);
    expect(result.truncated).toBe(true);
  });

  it('truncates the log when its total budget is exhausted', async () => {
    settings = resolveLedgerSettings({
      adapters: {
        [USER_INSTRUCTIONS_ADAPTER_ID]: {
          enabled: true,
          maxTokensPerEntry: undefined,
          maxTokens: 20,
        },
      },
    });

    const result = await makeService().build(
      makeConfig(),
      [],
      [user('first request ' + 'a'.repeat(200)), user('second request')],
    );
    const text = textOf(result.content);

    expect(text).toContain(USER_INSTRUCTIONS_BLOCK_TRUNCATION_MARKER);
    expect(result.truncated).toBe(true);
  });

  it('escapes whitespace variants of the container tags', async () => {
    // The adapter skips any text containing its own tag, so exercise the
    // escaping helper with whitespace variants that the filter does not catch.
    const result = await makeService().build(
      makeConfig(),
      [],
      [user('literal < user_instruction_log> and < context_ledger>')],
    );
    const text = textOf(result.content);

    expect(text).toContain('&lt;user_instruction_log&gt;');
    expect(text).toContain('&lt;context_ledger&gt;');
    expect(text).not.toContain('literal < user_instruction_log>');
  });

  it('recalls all 20 requests in order', async () => {
    const requests = Array.from(
      { length: 20 },
      (_, index) => `request ${String(index + 1).padStart(2, '0')}`,
    );

    const result = await makeService().build(
      makeConfig(),
      [],
      requests.map(user),
    );
    const text = textOf(result.content);

    for (const [index, request] of requests.entries()) {
      expect(text).toContain(`### Request ${index + 1}\n${request}`);
    }
    expect(text.indexOf(requests[0])).toBeLessThan(text.indexOf(requests[19]));
  });
});
