/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  ApprovalMode,
  ToolConfirmationOutcome,
  type Config,
  type ToolExecuteConfirmationDetails,
} from '@google/gemini-cli-core';
import { toPermissionOptions } from './acpUtils.js';

function createConfig(
  mode: ApprovalMode = ApprovalMode.DEFAULT,
  disableAlwaysAllow = false,
): Config {
  return {
    getApprovalMode: () => mode,
    getDisableAlwaysAllow: () => disableAlwaysAllow,
  } as unknown as Config;
}

function createExecDetails(
  overrides: Partial<ToolExecuteConfirmationDetails> = {},
): ToolExecuteConfirmationDetails {
  return {
    type: 'exec',
    title: 'Confirm Shell Command',
    command: 'rg --type ts "foo" ./packages',
    rootCommand: 'rg',
    rootCommands: ['rg'],
    onConfirm: async () => {},
    ...overrides,
  };
}

describe('toPermissionOptions', () => {
  it('offers session and persistent approvals for a normal exec command', () => {
    const options = toPermissionOptions(
      createExecDetails(),
      createConfig(),
      true,
    );

    expect(
      options.some(
        (option) => option.optionId === ToolConfirmationOutcome.ProceedAlways,
      ),
    ).toBe(true);
    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysAndSave,
      ),
    ).toBe(true);
  });

  it('offers session taint trust for untrusted flags in default mode', () => {
    const options = toPermissionOptions(
      createExecDetails({ untrustedFlags: ['--type', './packages'] }),
      createConfig(),
      true,
    );

    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint,
      ),
    ).toBe(true);
    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysAndSave,
      ),
    ).toBe(false);
  });

  it('labels session taint trust as all-flags in YOLO', () => {
    const options = toPermissionOptions(
      createExecDetails({ untrustedFlags: ['--type', './packages'] }),
      createConfig(ApprovalMode.YOLO),
    );

    expect(
      options.find(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint,
      )?.name,
    ).toBe('Allow command for this session (all flags)');
  });

  it('does not offer session taint trust for execution flags outside YOLO', () => {
    const options = toPermissionOptions(
      createExecDetails({
        untrustedFlags: ['--pre', '/tmp/evil.sh'],
        taintExecutionFlag: true,
      }),
      createConfig(),
    );

    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint,
      ),
    ).toBe(false);
    expect(
      options.some(
        (option) => option.optionId === ToolConfirmationOutcome.ProceedAlways,
      ),
    ).toBe(false);
  });

  it('does not offer session taint trust when the command is already trusted', () => {
    const options = toPermissionOptions(
      createExecDetails({
        untrustedFlags: ['--type'],
        taintTrusted: true,
      }),
      createConfig(),
    );

    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint,
      ),
    ).toBe(false);
  });

  it('does not offer session approvals for build-file risk', () => {
    const options = toPermissionOptions(
      createExecDetails({
        modifiedBuildFiles: ['/workspace/foo/BUILD'],
      }),
      createConfig(),
      true,
    );

    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlways ||
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysAndSave ||
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint,
      ),
    ).toBe(false);
  });

  it('respects disableAlwaysAllow', () => {
    const options = toPermissionOptions(
      createExecDetails({ untrustedFlags: ['--type'] }),
      createConfig(ApprovalMode.YOLO, true),
    );

    expect(
      options.some(
        (option) =>
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysTaint ||
          option.optionId === ToolConfirmationOutcome.ProceedAlways ||
          option.optionId === ToolConfirmationOutcome.ProceedAlwaysAndSave,
      ),
    ).toBe(false);
  });
});
