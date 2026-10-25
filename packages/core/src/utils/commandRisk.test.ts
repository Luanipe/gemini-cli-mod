/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { hasExecutionFlag } from './commandRisk.js';

describe('commandRisk', () => {
  it('does not treat common ripgrep flags as execution', () => {
    expect(hasExecutionFlag(['rg'], ['--type', './packages'])).toBe(false);
    expect(hasExecutionFlag(['rg'], ['--hidden', '--no-ignore'])).toBe(false);
    expect(hasExecutionFlag(['rg'], ['-e', 'baz'])).toBe(false);
    expect(hasExecutionFlag(['rg'], ['-c'])).toBe(false);
  });

  it('treats ripgrep preprocessors as execution', () => {
    expect(hasExecutionFlag(['rg'], ['--pre', '/tmp/evil.sh'])).toBe(true);
    expect(hasExecutionFlag(['rg'], ['--pre=/tmp/evil.sh'])).toBe(true);
    expect(hasExecutionFlag(['rg'], ['--hostname-bin', '/tmp/evil.sh'])).toBe(
      true,
    );
  });

  it('treats git config overrides and transport helpers as execution', () => {
    expect(hasExecutionFlag(['git'], ['-c', 'core.sshCommand=evil'])).toBe(
      true,
    );
    expect(hasExecutionFlag(['git'], ['--upload-pack=/tmp/evil.sh'])).toBe(
      true,
    );
    expect(hasExecutionFlag(['git'], ['-C', 'repo'])).toBe(false);
  });

  it('treats find exec flags as execution', () => {
    expect(hasExecutionFlag(['find'], ['-exec', '/tmp/evil.sh'])).toBe(true);
    expect(hasExecutionFlag(['find'], ['-name', '*.ts'])).toBe(false);
  });

  it('treats interpreter inline code as execution', () => {
    expect(hasExecutionFlag(['node'], ['-e', 'code'])).toBe(true);
    expect(hasExecutionFlag(['node'], ['-pe', 'code'])).toBe(true);
    expect(hasExecutionFlag(['python'], ['-c', 'print(1)'])).toBe(true);
    expect(hasExecutionFlag(['python'], ['-m', 'json.tool'])).toBe(true);
    expect(hasExecutionFlag(['bash'], ['-c', 'echo hi'])).toBe(true);
    expect(hasExecutionFlag(['bash'], ['-ec', 'echo hi'])).toBe(true);
    expect(hasExecutionFlag(['perl'], ['-e', 'code'])).toBe(true);
    expect(hasExecutionFlag(['perl'], ['-ne', 'code'])).toBe(true);
    expect(hasExecutionFlag(['ruby'], ['-e', 'code'])).toBe(true);
    expect(hasExecutionFlag(['php'], ['-r', 'code'])).toBe(true);
  });

  it('handles attached short-flag values without conflating case', () => {
    expect(hasExecutionFlag(['git'], ['-ccore.pager=evil', 'status'])).toBe(
      true,
    );
    expect(hasExecutionFlag(['git'], ['-C', 'repo', 'status'])).toBe(false);
  });

  it('handles case-insensitive flags for PowerShell and cmd', () => {
    expect(hasExecutionFlag(['powershell'], ['-Command', 'echo hi'])).toBe(
      true,
    );
    expect(hasExecutionFlag(['pwsh'], ['-EncodedCommand', 'abc'])).toBe(true);
    expect(hasExecutionFlag(['cmd'], ['/C', 'echo hi'])).toBe(true);
    expect(hasExecutionFlag(['powershell'], ['-NonInteractive'])).toBe(false);
    expect(
      hasExecutionFlag(['powershell'], ['-ExecutionPolicy', 'Bypass']),
    ).toBe(false);
    expect(hasExecutionFlag(['powershell'], ['-enc', 'abc'])).toBe(true);
    expect(hasExecutionFlag(['powershell'], ['-Command:Get-Process'])).toBe(
      true,
    );
  });

  it('treats bare script paths as execution for interpreters only', () => {
    expect(hasExecutionFlag(['bash'], ['/tmp/script.sh'])).toBe(true);
    expect(hasExecutionFlag(['bash'], ['./script.sh'])).toBe(true);
    expect(hasExecutionFlag(['node'], ['script.js'])).toBe(true);
    expect(hasExecutionFlag(['rg'], ['/tmp/data.txt'])).toBe(false);
    expect(hasExecutionFlag(['grep'], ['./src/index.ts'])).toBe(false);
  });

  it('ignores unknown commands', () => {
    expect(hasExecutionFlag(['unknown'], ['--pre', '/tmp/evil.sh'])).toBe(
      false,
    );
  });

  it('returns false when there are no flags', () => {
    expect(hasExecutionFlag(['rg'], [])).toBe(false);
  });
});
