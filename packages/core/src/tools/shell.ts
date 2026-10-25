/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fsPromises from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as shellParse } from 'shell-quote';
import { debugLogger } from '../index.js';
import { type SandboxPermissions } from '../services/sandboxManager.js';
import { ToolErrorType } from './tool-error.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  ToolConfirmationOutcome,
  Kind,
  type ToolInvocation,
  type ToolResult,
  type BackgroundExecutionData,
  type ToolCallConfirmationDetails,
  type ToolExecuteConfirmationDetails,
  type PolicyUpdateOptions,
  type ExecuteOptions,
  type ForcedToolDecision,
} from './tools.js';

import { getErrorMessage } from '../utils/errors.js';
import { summarizeToolOutput } from '../utils/summarizer.js';
import {
  ShellExecutionService,
  type ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { formatBytes } from '../utils/formatters.js';
import type { AnsiOutput, AnsiToken } from '../utils/terminalSerializer.js';
import {
  getCommandRoots,
  initializeShellParsers,
  stripShellWrapper,
  parseCommandDetails,
  hasRedirection,
  detectCommandSubstitution,
  normalizeCommand,
  escapeShellArg,
  REDIRECTION_NAMES,
} from '../utils/shell-utils.js';
import { SHELL_TOOL_NAME } from './tool-names.js';
import { PARAM_ADDITIONAL_PERMISSIONS } from './definitions/base-declarations.js';
import { ApprovalMode } from '../policy/types.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  extractUntrustedContext,
  findUntrustedFlags,
  isBuildOrTestCommand,
  getModifiedBuildFiles,
} from '../utils/untrustedContextTracker.js';
import {
  hasExecutionFlag,
  getCommandExecutionProfile,
} from '../utils/commandRisk.js';
import { areCommandsTrustedForSession } from './taintTrustStore.js';
import { getShellDefinition } from './definitions/coreTools.js';
import { resolveToolDeclaration } from './definitions/resolver.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { Content } from '@google/genai';
import { toPathKey, isSubpath, resolveToRealPath } from '../utils/paths.js';
import {
  getProactiveToolSuggestions,
  isNetworkReliantCommand,
} from '../sandbox/utils/proactivePermissions.js';
import { wrapUntrusted } from '../utils/textUtils.js';

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
export const LIVE_OUTPUT_MAX_BUFFER_CHARS = 100_000;

// Delay so user does not see the output of the process before the process is moved to the background.
const BACKGROUND_DELAY_MS = 200;
const SHOW_NL_DESCRIPTION_THRESHOLD = 150;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function trimLiveOutputBuffer(output: string): string {
  if (output.length <= LIVE_OUTPUT_MAX_BUFFER_CHARS) {
    return output;
  }

  let startIndex = output.length - LIVE_OUTPUT_MAX_BUFFER_CHARS;
  const firstCodeUnit = output.charCodeAt(startIndex);
  if (
    firstCodeUnit >= LOW_SURROGATE_START &&
    firstCodeUnit <= LOW_SURROGATE_END
  ) {
    startIndex += 1;
  }
  return output.slice(startIndex);
}

function appendTaintNotice(
  display: string | AnsiOutput,
  notice: string,
): string | AnsiOutput {
  if (typeof display === 'string') {
    return display ? `${display}\n\n${notice}` : notice;
  }

  const noticeLines: AnsiToken[][] = notice.split('\n').map((text) => [
    {
      text,
      bold: false,
      italic: false,
      underline: false,
      dim: false,
      inverse: false,
      isUninitialized: false,
      fg: '',
      bg: '',
    },
  ]);
  return [...display, ...noticeLines];
}

const WRAPPER_COMMANDS = new Set([
  'sudo',
  'env',
  'time',
  'command',
  'nohup',
  'exec',
  'xargs',
  'timeout',
  'nice',
  'ionice',
  'stdbuf',
  'setsid',
  'watch',
  'chroot',
  'fakeroot',
  'doas',
  'pkexec',
  'busybox',
]);

const WRAPPER_FLAGS_WITH_VALUES: Readonly<Record<string, ReadonlySet<string>>> =
  {
    sudo: new Set([
      '-u',
      '--user',
      '-g',
      '--group',
      '-p',
      '--prompt',
      '-C',
      '--close-from',
      '-T',
      '--command-timeout',
      '-r',
      '--role',
      '-t',
      '--type',
      '-U',
      '--other-user',
      '-R',
      '--chroot',
      '-D',
      '--chdir',
    ]),
    env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
    time: new Set(['-f', '--format', '-o', '--output']),
    exec: new Set(['-a']),
    xargs: new Set([
      '-I',
      '--replace',
      '-n',
      '--max-args',
      '-P',
      '--max-procs',
      '-s',
      '--max-chars',
      '-L',
      '--max-lines',
      '-E',
      '--eof',
      '-d',
      '--delimiter',
      '-a',
      '--arg-file',
    ]),
    timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
    nice: new Set(['-n', '--adjustment']),
    ionice: new Set([
      '-c',
      '--class',
      '-n',
      '--classdata',
      '-p',
      '--pid',
      '-P',
      '--pgid',
      '-u',
      '--uid',
    ]),
    stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
    watch: new Set(['-n', '--interval']),
    chroot: new Set(['--userspec', '--groups']),
    fakeroot: new Set([
      '-l',
      '--lib',
      '-i',
      '--input',
      '-s',
      '--save-file',
      '--faked',
    ]),
    doas: new Set(['-u', '--user']),
    pkexec: new Set(['--user']),
  };

/**
 * Some wrappers take a positional argument before the command they execute
 * (for example `timeout 5 rg` or `chroot /newroot rg`).
 */
const WRAPPER_POSITIONAL_ARGS_TO_SKIP: Readonly<Record<string, number>> = {
  timeout: 1,
  chroot: 1,
};

/**
 * Common commands whose non-flag arguments are data, not a nested command.
 * They keep the argument scan from inventing an execution risk for things like
 * `cat node ./src`. Package managers are intentionally excluded because they
 * can execute child commands.
 */
const NON_EXECUTING_COMMANDS = new Set([
  'cat',
  'ls',
  'sed',
  'awk',
  'sort',
  'head',
  'tail',
  'cut',
  'tr',
  'wc',
  'uniq',
  'diff',
  'stat',
  'file',
  'less',
  'more',
]);

function getWrapperBaseName(wrapper: string): string {
  const normalized = wrapper.trim().replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function tokenizeCommand(command: string): string[] {
  try {
    return shellParse(command, (key) => `$${key}`).flatMap((entry) => {
      if (typeof entry === 'string') {
        return [entry];
      }
      if (
        entry &&
        typeof entry === 'object' &&
        'pattern' in entry &&
        typeof entry.pattern === 'string'
      ) {
        return [entry.pattern];
      }
      return [];
    });
  } catch {
    return command.trim().split(/\s+/);
  }
}

/**
 * Returns the command-position token of a wrapper. It deliberately does not
 * scan for "any known command" in the arguments: `sudo apt install git` must
 * resolve to `apt`, never to `git`.
 */
function findNestedCommand(
  wrapper: string,
  args: readonly string[],
): string | undefined {
  const base = getWrapperBaseName(wrapper);
  if (!WRAPPER_COMMANDS.has(base)) {
    return undefined;
  }

  const valueFlags = WRAPPER_FLAGS_WITH_VALUES[base];
  const positionalsToSkip = WRAPPER_POSITIONAL_ARGS_TO_SKIP[base] ?? 0;
  let skippedPositionals = 0;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!token || token.includes('=')) {
      continue;
    }
    if (token === '--') {
      const next = args[i + 1];
      if (next) {
        return next;
      }
      break;
    }
    if (token.startsWith('-')) {
      if (valueFlags?.has(token) && i + 1 < args.length) {
        i++;
      }
      continue;
    }
    if (skippedPositionals < positionalsToSkip) {
      skippedPositionals++;
      continue;
    }
    return token;
  }

  return undefined;
}

export interface ShellToolParams {
  command: string;
  description?: string;
  dir_path?: string;
  is_background?: boolean;
  delay_ms?: number;
  [PARAM_ADDITIONAL_PERMISSIONS]?: SandboxPermissions;
}

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  private proactivePermissionsConfirmed?: SandboxPermissions;

  private taintCache?: {
    key: string;
    flags: string[];
    roots: string[];
    executionRoots: string[];
    executionFlag: boolean;
  };

  constructor(
    private readonly context: AgentLoopContext,
    params: ShellToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ) {
    super(params, messageBus, _toolName, _toolDisplayName);
  }

  /**
   * Wraps a command in a subshell to capture background process IDs (PIDs)
   * using an EXIT trap. Uses newlines to prevent breaking heredocs or trailing
   * comments.
   *
   * @param command The raw command string to execute.
   * @param tempFilePath Path to the temporary file where PIDs will be written.
   * @param isWindows Whether the current platform is Windows (if true, the command is returned as-is).
   * @returns The wrapped command string.
   */
  private wrapCommandForBackgroundPIDs(
    command: string,
    tempFilePath: string,
    isWindows: boolean,
  ): string {
    if (isWindows) {
      return command;
    }
    let trimmed = command.trim();
    if (!trimmed) {
      return '';
    }
    if (trimmed.endsWith('\\')) {
      trimmed += ' ';
    }
    const escapedTempFilePath = escapeShellArg(tempFilePath, 'bash');
    return `_bgpids_file=${escapedTempFilePath}\n(\n  trap 'jobs -p > "$_bgpids_file"' EXIT\n${trimmed}\n)\n__code=$?\nexit $__code`;
  }

  private getContextualDetails(): string {
    let details = '';
    // append optional [in directory]
    // note explanation is needed even if validation fails due to absolute path
    if (this.params.dir_path) {
      details += `[in ${this.params.dir_path}]`;
    } else {
      details += `[current working directory ${process.cwd()}]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      details += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    if (this.params.is_background) {
      details += ' [background]';
    }
    return details;
  }

  getDescription(): string {
    const descStr = this.params.description?.trim();
    const commandStr = this.params.command;
    return Array.from(commandStr).length <= SHOW_NL_DESCRIPTION_THRESHOLD ||
      !descStr
      ? commandStr
      : descStr;
  }

  private simplifyPaths(paths: Set<string>): string[] {
    if (paths.size === 0) return [];
    const rawPaths = Array.from(paths);

    // 1. Remove redundant paths (subpaths of already included paths)
    const sorted = rawPaths.sort((a, b) => a.length - b.length);
    const nonRedundant: string[] = [];
    for (const p of sorted) {
      if (!nonRedundant.some((s) => isSubpath(s, p))) {
        nonRedundant.push(p);
      }
    }

    // 2. Consolidate clusters: if >= 3 paths share the same immediate parent, use the parent
    const parentCounts = new Map<string, string[]>();
    for (const p of nonRedundant) {
      const parent = path.dirname(p);
      if (!parentCounts.has(parent)) {
        parentCounts.set(parent, []);
      }
      parentCounts.get(parent)!.push(p);
    }

    const finalPaths = new Set<string>();

    const sensitiveDirs = new Set([
      os.homedir(),
      path.dirname(os.homedir()),
      path.sep,
      path.join(path.sep, 'etc'),
      path.join(path.sep, 'usr'),
      path.join(path.sep, 'var'),
      path.join(path.sep, 'bin'),
      path.join(path.sep, 'sbin'),
      path.join(path.sep, 'lib'),
      path.join(path.sep, 'root'),
      path.join(path.sep, 'home'),
      path.join(path.sep, 'Users'),
    ]);

    if (os.platform() === 'win32') {
      const systemRoot = process.env['SystemRoot'];
      if (systemRoot) {
        sensitiveDirs.add(systemRoot);
        sensitiveDirs.add(path.join(systemRoot, 'System32'));
      }
      const programFiles = process.env['ProgramFiles'];
      if (programFiles) sensitiveDirs.add(programFiles);
      const programFilesX86 = process.env['ProgramFiles(x86)'];
      if (programFilesX86) sensitiveDirs.add(programFilesX86);
    }

    for (const [parent, children] of parentCounts.entries()) {
      const isSensitive = sensitiveDirs.has(parent);
      if (children.length >= 3 && parent.length > 1 && !isSensitive) {
        finalPaths.add(parent);
      } else {
        for (const child of children) {
          finalPaths.add(child);
        }
      }
    }

    // 3. Final redundancy check after consolidation
    const finalSorted = Array.from(finalPaths).sort(
      (a, b) => a.length - b.length,
    );
    const result: string[] = [];
    for (const p of finalSorted) {
      if (!result.some((s) => isSubpath(s, p))) {
        result.push(p);
      }
    }

    return result;
  }

  override getDisplayTitle(): string {
    return this.params.command;
  }

  private getHistory(): readonly Content[] {
    const clientFromProp = this.context.geminiClient;
    if (clientFromProp && typeof clientFromProp.getHistory === 'function') {
      return clientFromProp.getHistory();
    }
    const clientFromMethod = this.context.config?.getGeminiClient?.();
    if (clientFromMethod && typeof clientFromMethod.getHistory === 'function') {
      return clientFromMethod.getHistory();
    }
    return [];
  }

  override getExplanation(): string {
    return this.getContextualDetails().trim();
  }

  private getFallbackRoot(command: string): string {
    const wrapperTokens = new Set([
      'sudo',
      'env',
      'time',
      'command',
      'nohup',
      'exec',
    ]);
    return (
      command
        .trim()
        .split(/\s+/)
        .find(
          (token) =>
            token.length > 0 &&
            !token.includes('=') &&
            !token.startsWith('-') &&
            !wrapperTokens.has(token.toLowerCase()),
        ) ?? ''
    );
  }

  private getTaintAnalysis(): {
    flags: string[];
    roots: string[];
    trusted: boolean;
    executionFlag: boolean;
  } {
    const command = stripShellWrapper(this.params.command);
    const history = this.getHistory();
    // The cache lives for one invocation. Keying on the history length avoids
    // rescanning it across shouldConfirmExecute/getConfirmationDetails/execute
    // without holding a reference to a potentially large history.
    const cacheKey = `${command}\u0000${history.length}`;

    if (!this.taintCache || this.taintCache.key !== cacheKey) {
      const untrustedContext = extractUntrustedContext(history);
      const flags = findUntrustedFlags(command, untrustedContext);
      const { trustRoots, executionRoots } = this.getTaintRoots(command);
      this.taintCache = {
        key: cacheKey,
        flags,
        roots: trustRoots,
        executionRoots,
        executionFlag: hasExecutionFlag(executionRoots, flags),
      };
    }

    return {
      flags: this.taintCache.flags,
      roots: this.taintCache.roots,
      trusted: areCommandsTrustedForSession(
        this.context.config,
        this.taintCache.roots,
      ),
      executionFlag: this.taintCache.executionFlag,
    };
  }

  /**
   * Separates the roots used for trust/labels from the roots used for the
   * execution-flag guard.
   *
   * Trust roots are the commands a user actually approves: for `sudo rg`, that
   * is `rg`, not `sudo`. Execution roots include the outer command as well so
   * wrapper flags can be evaluated, and also include any profiled command found
   * in the wrapper's arguments. The extra execution roots only make the guard
   * stricter; they never widen what is trusted.
   */
  private getTaintRoots(command: string): {
    trustRoots: string[];
    executionRoots: string[];
  } {
    const outerRoots = getCommandRoots(command);
    const parsed = parseCommandDetails(command);
    const trustRoots = new Set<string>();
    const executionRoots = new Set<string>(outerRoots);

    if (parsed && !parsed.hasError && parsed.details.length > 0) {
      for (const detail of parsed.details) {
        if (REDIRECTION_NAMES.has(detail.name)) {
          continue;
        }

        const tokens = tokenizeCommand(detail.text || detail.name);
        let commandIndex = 0;
        while (
          commandIndex < tokens.length &&
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex])
        ) {
          commandIndex++;
        }

        const commandName = tokens[commandIndex] || detail.name;
        const detailArgs = tokens.slice(commandIndex + 1);
        const nested = findNestedCommand(commandName, detailArgs);
        const profile = getCommandExecutionProfile(commandName);

        if (nested) {
          trustRoots.add(nested);
          executionRoots.add(nested);
        } else {
          trustRoots.add(commandName);
        }

        // Defense in depth for wrappers we do not know: if an argument names a
        // command we have a profile for, include it for the guard only. This
        // can over-confirm but cannot grant trust. Known non-executing commands
        // are skipped so their data arguments do not look like child commands.
        if (
          !nested &&
          !profile &&
          !NON_EXECUTING_COMMANDS.has(getWrapperBaseName(commandName))
        ) {
          for (const token of [commandName, ...detailArgs]) {
            if (getCommandExecutionProfile(token)) {
              executionRoots.add(token);
            }
          }
        }
      }
    } else {
      for (const token of tokenizeCommand(command)) {
        if (getCommandExecutionProfile(token)) {
          executionRoots.add(token);
        }
      }
      for (const root of outerRoots) {
        trustRoots.add(root);
      }
    }

    if (trustRoots.size === 0) {
      const fallbackRoot = this.getFallbackRoot(command);
      if (fallbackRoot) {
        trustRoots.add(fallbackRoot);
        executionRoots.add(fallbackRoot);
      }
    }

    return {
      trustRoots: [...trustRoots],
      executionRoots: [...executionRoots],
    };
  }

  private isTaintTrustEffective(analysis: {
    trusted: boolean;
    executionFlag: boolean;
  }): boolean {
    return (
      analysis.trusted &&
      (this.context.config.getApprovalMode() === ApprovalMode.YOLO ||
        !analysis.executionFlag)
    );
  }

  /**
   * Whether this command has any arguments sourced from untrusted context,
   * regardless of session trust. Used to keep persistent approvals disabled.
   */
  hasUntrustedFlags(): boolean {
    return this.getTaintAnalysis().flags.length > 0;
  }

  /**
   * Whether a build/test command runs after a build file was modified earlier
   * in this session.
   */
  hasModifiedBuildFileRisk(): boolean {
    const command = stripShellWrapper(this.params.command);
    return (
      isBuildOrTestCommand(command) &&
      getModifiedBuildFiles(this.context.config).length > 0
    );
  }

  /**
   * Whether untrusted flags should still block this invocation after applying
   * session trust. YOLO trusts all flags; other modes keep guarding
   * command-specific execution flags.
   */
  hasUntrustedFlagRisk(): boolean {
    const analysis = this.getTaintAnalysis();
    return analysis.flags.length > 0 && !this.isTaintTrustEffective(analysis);
  }

  hasTaintedOrBuildFileRisk(): boolean {
    return this.hasModifiedBuildFileRisk() || this.hasUntrustedFlagRisk();
  }

  override getPolicyUpdateOptions(
    outcome: ToolConfirmationOutcome,
  ): PolicyUpdateOptions | undefined {
    if (
      outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave ||
      outcome === ToolConfirmationOutcome.ProceedAlways
    ) {
      const command = stripShellWrapper(this.params.command);
      if (this.hasUntrustedFlags() || this.hasModifiedBuildFileRisk()) {
        return undefined;
      }
      const rootCommands = [...new Set(getCommandRoots(command))];
      const allowRedirection = hasRedirection(command) ? true : undefined;

      if (rootCommands.length > 0) {
        return { commandPrefix: rootCommands, allowRedirection };
      }
      return { commandPrefix: this.params.command, allowRedirection };
    }
    return undefined;
  }

  override async shouldConfirmExecute(
    abortSignal: AbortSignal,
    forcedDecision?: ForcedToolDecision,
  ): Promise<ToolCallConfirmationDetails | false> {
    if (forcedDecision === 'deny') {
      return super.shouldConfirmExecute(abortSignal, forcedDecision);
    }

    if (this.hasTaintedOrBuildFileRisk()) {
      return this.getConfirmationDetails(abortSignal);
    }

    if (
      this.context.config.getApprovalMode() === ApprovalMode.YOLO &&
      forcedDecision !== 'ask_user'
    ) {
      return super.shouldConfirmExecute(abortSignal, forcedDecision);
    }

    if (this.params[PARAM_ADDITIONAL_PERMISSIONS]) {
      return this.getConfirmationDetails(abortSignal);
    }

    if (this.context.config.getSandboxEnabled()) {
      const command = stripShellWrapper(this.params.command);
      const rootCommands = getCommandRoots(command);
      const rawRootCommand = rootCommands[0];

      if (rawRootCommand) {
        const rootCommand = normalizeCommand(rawRootCommand);
        const proactive = await getProactiveToolSuggestions(rootCommand);
        if (proactive) {
          const mode = this.context.config.getApprovalMode();
          const modeConfig =
            this.context.config.sandboxPolicyManager.getModeConfig(mode);
          const approved =
            this.context.config.sandboxPolicyManager.getCommandPermissions(
              rootCommand,
            );

          const hasNetwork = modeConfig.network || approved.network;
          const missingNetwork = !!proactive.network && !hasNetwork;

          // Detect commands or sub-commands that definitely need network
          const parsed = parseCommandDetails(command);
          const subCommand = parsed?.details[0]?.args?.[0];
          const needsNetwork = isNetworkReliantCommand(rootCommand, subCommand);

          if (needsNetwork) {
            // Add write permission to the current directory if we are in readonly mode
            const isReadonlyMode = modeConfig.readonly ?? false;

            if (isReadonlyMode) {
              const cwd =
                this.params.dir_path || this.context.config.getTargetDir();
              proactive.fileSystem = proactive.fileSystem || {
                read: [],
                write: [],
              };
              proactive.fileSystem.write = proactive.fileSystem.write || [];
              if (!proactive.fileSystem.write.includes(cwd)) {
                proactive.fileSystem.write.push(cwd);
                proactive.fileSystem.read = proactive.fileSystem.read || [];
                if (!proactive.fileSystem.read.includes(cwd)) {
                  proactive.fileSystem.read.push(cwd);
                }
              }
            }

            const isApproved = (
              requestedPath: string,
              approvedPaths?: string[],
            ): boolean => {
              if (!approvedPaths || approvedPaths.length === 0) return false;
              const requestedRealIdentity = toPathKey(
                resolveToRealPath(requestedPath),
              );

              // Identity check is fast, subpath check is slower
              return approvedPaths.some((p) => {
                const approvedRealIdentity = toPathKey(resolveToRealPath(p));
                return (
                  requestedRealIdentity === approvedRealIdentity ||
                  isSubpath(approvedRealIdentity, requestedRealIdentity)
                );
              });
            };

            const missingRead = (proactive.fileSystem?.read || []).filter(
              (p) => !isApproved(p, approved.fileSystem?.read),
            );
            const missingWrite = (proactive.fileSystem?.write || []).filter(
              (p) => !isApproved(p, approved.fileSystem?.write),
            );

            const needsExpansion =
              missingRead.length > 0 ||
              missingWrite.length > 0 ||
              missingNetwork;

            if (needsExpansion) {
              const details = await this.getConfirmationDetails(
                abortSignal,
                proactive,
              );
              if (details && details.type === 'sandbox_expansion') {
                const originalOnConfirm = details.onConfirm;
                details.onConfirm = async (
                  outcome: ToolConfirmationOutcome,
                ) => {
                  await originalOnConfirm(outcome);
                  if (outcome !== ToolConfirmationOutcome.Cancel) {
                    this.proactivePermissionsConfirmed = proactive;
                  }
                };
              }
              return details;
            }
          }
        }
      }
    }

    return super.shouldConfirmExecute(abortSignal, forcedDecision);
  }

  protected override async getConfirmationDetails(
    _abortSignal: AbortSignal,
    proactivePermissions?: SandboxPermissions,
  ): Promise<ToolCallConfirmationDetails | false> {
    const command = stripShellWrapper(this.params.command);

    const parsed = parseCommandDetails(command);
    let rootCommandDisplay = '';

    if (!parsed || parsed.hasError || parsed.details.length === 0) {
      // Fallback if parser fails
      const fallback = command.trim().split(/\s+/)[0];
      rootCommandDisplay = fallback || 'shell command';
      if (hasRedirection(command)) {
        rootCommandDisplay += ', redirection';
      }
    } else {
      rootCommandDisplay = parsed.details
        .map((detail) => detail.name)
        .join(', ');
    }

    const {
      flags: untrustedFlags,
      roots: rootCommands,
      trusted: taintTrusted,
      executionFlag: taintExecutionFlag,
    } = this.getTaintAnalysis();
    const rootCommand = rootCommands[0] || 'shell';

    const modifiedBuildFiles = getModifiedBuildFiles(this.context.config);
    const isBuildCmd = isBuildOrTestCommand(command);

    const hasSecurityWarning =
      untrustedFlags.length > 0 ||
      (isBuildCmd && modifiedBuildFiles.length > 0);

    // Proactively suggest expansion for known network-heavy tools (npm install, etc.)
    // to avoid hangs when network is restricted by default.
    const effectiveAdditionalPermissions =
      this.params[PARAM_ADDITIONAL_PERMISSIONS] || proactivePermissions;

    // Rely entirely on PolicyEngine for interactive confirmation.
    // If we are here, it means PolicyEngine returned ASK_USER (or no message bus),
    // so we must provide confirmation details.
    // If additional_permissions are provided, and no security warnings are present,
    // it's an expansion request
    if (effectiveAdditionalPermissions && !hasSecurityWarning) {
      return {
        type: 'sandbox_expansion',
        title: proactivePermissions
          ? 'Sandbox Expansion Request (Recommended)'
          : 'Sandbox Expansion Request',
        command: this.params.command,
        rootCommand: rootCommandDisplay,
        additionalPermissions: effectiveAdditionalPermissions,
        onConfirm: async (outcome: ToolConfirmationOutcome) => {
          if (outcome === ToolConfirmationOutcome.ProceedAlwaysAndSave) {
            this.context.config.sandboxPolicyManager.addPersistentApproval(
              rootCommand,
              effectiveAdditionalPermissions,
            );
          } else if (outcome === ToolConfirmationOutcome.ProceedAlways) {
            this.context.config.sandboxPolicyManager.addSessionApproval(
              rootCommand,
              effectiveAdditionalPermissions,
            );
          }
        },
      };
    }

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: rootCommandDisplay,
      rootCommands,
      untrustedFlags: untrustedFlags.length > 0 ? untrustedFlags : undefined,
      taintTrusted: untrustedFlags.length > 0 ? taintTrusted : undefined,
      taintExecutionFlag:
        untrustedFlags.length > 0 ? taintExecutionFlag : undefined,
      modifiedBuildFiles:
        isBuildCmd && modifiedBuildFiles.length > 0
          ? modifiedBuildFiles
          : undefined,
      onConfirm: async (_outcome: ToolConfirmationOutcome) => {
        // Policy updates are now handled centrally by the scheduler
      },
    };
    return confirmationDetails;
  }

  async execute(options: ExecuteOptions): Promise<ToolResult> {
    const {
      abortSignal: signal,
      updateOutput,
      shellExecutionConfig,
      setExecutionIdCallback,
    } = options;
    const strippedCommand = stripShellWrapper(this.params.command);

    if (detectCommandSubstitution(strippedCommand)) {
      return {
        llmContent:
          'Command injection detected: command substitution syntax ' +
          '($(), backticks, <() or >()) found in command arguments. ' +
          'On PowerShell, @() array subexpressions and $() subexpressions are also blocked. ' +
          'This is a security risk and the command was blocked.',
        returnDisplay:
          'Blocked: command substitution detected in shell command.',
      };
    }

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    const isWindows = os.platform() === 'win32';
    let tempFilePath = '';
    let tempDir = '';
    let isBackgrounded = false;

    const timeoutMs = this.context.config.getShellToolInactivityTimeout();
    const timeoutController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | undefined;
    let trailingFlushTimer: ReturnType<typeof setTimeout> | null = null;

    // Handle signal combination manually to avoid TS issues or runtime missing features
    const combinedController = new AbortController();

    const onAbort = () => combinedController.abort();
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-shell-'));
      tempFilePath = path.join(tempDir, 'bgpids.tmp');

      // Windows shells do not support the POSIX jobs output used here.
      const commandToExecute = this.wrapCommandForBackgroundPIDs(
        strippedCommand,
        tempFilePath,
        isWindows,
      );

      const cwd = this.params.dir_path
        ? path.resolve(this.context.config.getTargetDir(), this.params.dir_path)
        : this.context.config.getTargetDir();

      const validationError = this.context.config.validatePathAccess(cwd);
      if (validationError) {
        return {
          llmContent: validationError,
          returnDisplay: 'Path not in workspace.',
          error: {
            message: validationError,
            type: ToolErrorType.PATH_NOT_IN_WORKSPACE,
          },
        };
      }
      let cumulativeOutput: string | AnsiOutput = '';
      let lastUpdateTime = 0;
      let hasFlushedOutput = false;
      let hasPendingOutput = false;
      let isBinaryStream = false;

      const appendToLiveOutputBuffer = (chunk: string) => {
        const currentOutput =
          typeof cumulativeOutput === 'string' ? cumulativeOutput : '';
        if (chunk.length >= LIVE_OUTPUT_MAX_BUFFER_CHARS) {
          cumulativeOutput = trimLiveOutputBuffer(chunk);
          return;
        }

        const nextOutput = currentOutput + chunk;
        cumulativeOutput = trimLiveOutputBuffer(nextOutput);
      };

      const cancelTrailingFlush = () => {
        if (trailingFlushTimer !== null) {
          clearTimeout(trailingFlushTimer);
          trailingFlushTimer = null;
        }
      };

      const flushOutput = () => {
        cancelTrailingFlush();
        if (!hasPendingOutput || !updateOutput || this.params.is_background) {
          return;
        }

        updateOutput(cumulativeOutput);
        hasPendingOutput = false;
        hasFlushedOutput = true;
        lastUpdateTime = Date.now();
      };

      const scheduleTrailingFlush = () => {
        if (
          trailingFlushTimer !== null ||
          !updateOutput ||
          this.params.is_background
        ) {
          return;
        }
        const elapsedSinceLastUpdate = Date.now() - lastUpdateTime;
        const trailingDelayMs = Math.max(
          OUTPUT_UPDATE_INTERVAL_MS - elapsedSinceLastUpdate,
          0,
        );
        trailingFlushTimer = setTimeout(() => {
          trailingFlushTimer = null;
          flushOutput();
        }, trailingDelayMs);
      };

      const resetTimeout = () => {
        if (timeoutMs <= 0) {
          return;
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        timeoutTimer = setTimeout(() => {
          timeoutController.abort();
        }, timeoutMs);
      };

      signal.addEventListener('abort', onAbort, { once: true });
      timeoutController.signal.addEventListener('abort', onAbort, {
        once: true,
      });

      // Start timeout
      resetTimeout();

      const { result: resultPromise, pid } =
        await ShellExecutionService.execute(
          commandToExecute,
          cwd,
          (event: ShellOutputEvent) => {
            resetTimeout(); // Reset timeout on any event

            let shouldUpdate = false;

            switch (event.type) {
              case 'data':
                if (isBinaryStream) break;
                if (typeof event.chunk === 'string') {
                  appendToLiveOutputBuffer(event.chunk);
                  shouldUpdate =
                    !hasFlushedOutput ||
                    Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS;
                  if (!shouldUpdate) {
                    scheduleTrailingFlush();
                  }
                } else {
                  cumulativeOutput = event.chunk;
                  shouldUpdate = true;
                }
                hasPendingOutput = true;
                break;
              case 'binary_detected':
                isBinaryStream = true;
                cumulativeOutput =
                  '[Binary output detected. Halting stream...]';
                hasPendingOutput = true;
                shouldUpdate = true;
                break;
              case 'binary_progress':
                isBinaryStream = true;
                cumulativeOutput = `[Receiving binary output... ${formatBytes(
                  event.bytesReceived,
                )} received]`;
                hasPendingOutput = true;
                if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
                  shouldUpdate = true;
                }
                break;
              case 'exit':
                flushOutput();
                break;
              default: {
                throw new Error('An unhandled ShellOutputEvent was found.');
              }
            }

            if (shouldUpdate && !this.params.is_background) {
              flushOutput();
            }
          },
          combinedController.signal,
          this.context.config.isInteractiveShellEnabled(),
          {
            ...shellExecutionConfig,
            env: this.context.config.env,
            sessionId: this.context.config?.getSessionId?.() ?? 'default',
            pager: 'cat',
            sanitizationConfig:
              shellExecutionConfig?.sanitizationConfig ??
              this.context.config.sanitizationConfig,
            sandboxManager: this.context.config.sandboxManager,
            additionalPermissions: {
              network:
                this.params[PARAM_ADDITIONAL_PERMISSIONS]?.network ||
                this.proactivePermissionsConfirmed?.network,
              fileSystem: {
                read: [
                  ...(this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem
                    ?.read || []),
                  ...(this.proactivePermissionsConfirmed?.fileSystem?.read ||
                    []),
                ],
                write: [
                  ...(this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem
                    ?.write || []),
                  ...(this.proactivePermissionsConfirmed?.fileSystem?.write ||
                    []),
                ],
              },
            },
            backgroundCompletionBehavior:
              this.context.config.getShellBackgroundCompletionBehavior(),
            originalCommand: strippedCommand,
            tempDir,
          },
        );

      if (pid) {
        if (setExecutionIdCallback) {
          setExecutionIdCallback(pid);
        }

        let completed = false;
        if (this.params.is_background) {
          const sessionId = this.context.config?.getSessionId?.() ?? 'default';
          const delay = this.params.delay_ms ?? BACKGROUND_DELAY_MS;
          let promotionTimer: ReturnType<typeof setTimeout> | null = setTimeout(
            () => {
              promotionTimer = null;
              if (!completed) {
                try {
                  ShellExecutionService.background(
                    pid,
                    sessionId,
                    strippedCommand,
                    tempDir,
                  );
                  isBackgrounded = true;
                } catch (err) {
                  debugLogger.error(
                    'Failed to background shell execution:',
                    err,
                  );
                }
              }
            },
            delay,
          );

          const clearPromotionTimer = () => {
            if (promotionTimer) {
              clearTimeout(promotionTimer);
              promotionTimer = null;
            }
          };

          resultPromise
            .then(() => {
              completed = true;
              clearPromotionTimer();
            })
            .catch(() => {
              completed = true;
              clearPromotionTimer();
            });

          let raceTimeoutId: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            resultPromise.catch(() => {}),
            new Promise<void>((resolve) => {
              raceTimeoutId = setTimeout(resolve, delay);
            }),
          ]);
          if (raceTimeoutId) {
            clearTimeout(raceTimeoutId);
          }

          if (!completed) {
            return {
              llmContent: `Command is running in background. PID: ${pid}. Initial output:\n${cumulativeOutput}`,
              returnDisplay: `Background process started with PID ${pid}.`,
            };
          }
        }
      }

      const result = await resultPromise;
      if (result.backgrounded) {
        isBackgrounded = true;
      } else {
        flushOutput();
      }

      const backgroundPIDs: number[] = [];
      if (os.platform() !== 'win32') {
        let tempFileExists = false;
        try {
          await fsPromises.access(tempFilePath);
          tempFileExists = true;
        } catch {
          tempFileExists = false;
        }

        if (tempFileExists) {
          const backgroundPIDContent = await fsPromises.readFile(
            tempFilePath,
            'utf8',
          );
          const backgroundPIDLines = backgroundPIDContent
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          for (const line of backgroundPIDLines) {
            if (!/^\d+$/.test(line)) {
              if (
                line.includes('sysmond service not found') ||
                line.includes('Cannot get process list') ||
                line.includes('sysmon request failed')
              ) {
                continue;
              }
              debugLogger.error(`background pid output: ${line}`);
            }
            const pid = Number(line);
            if (pid !== result.pid) {
              backgroundPIDs.push(pid);
            }
          }
        } else {
          if (!signal.aborted && !result.backgrounded) {
            debugLogger.error('missing background pid output');
          }
        }
      }

      let data: BackgroundExecutionData | undefined;

      let llmContent = '';
      let timeoutMessage = '';
      if (result.aborted) {
        if (timeoutController.signal.aborted) {
          timeoutMessage = `Command was automatically cancelled because it exceeded the timeout of ${(
            timeoutMs / 60000
          ).toFixed(1)} minutes without output.`;
          llmContent = timeoutMessage;
        } else {
          llmContent =
            'Command was cancelled by user before it could complete.';
        }
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      } else if (this.params.is_background || result.backgrounded) {
        llmContent = `Command moved to background (PID: ${result.pid}). Output hidden. Press Ctrl+B to view.`;
        data = {
          pid: result.pid,
          command: this.params.command,
          initialOutput: result.output,
        };
      } else {
        // Create a formatted error string for display, replacing the wrapper command
        // with the user-facing command.
        const llmContentParts = [`Output: ${result.output || '(empty)'}`];

        if (result.error) {
          const finalError = result.error.message.replaceAll(
            commandToExecute,
            this.params.command,
          );
          llmContentParts.push(`Error: ${finalError}`);
        }

        if (result.exitCode !== null && result.exitCode !== 0) {
          llmContentParts.push(`Exit Code: ${result.exitCode}`);
          data = {
            exitCode: result.exitCode,
            isError: true,
          };
        }

        if (result.signal) {
          llmContentParts.push(`Signal: ${result.signal}`);
        }
        if (backgroundPIDs.length) {
          llmContentParts.push(`Background PIDs: ${backgroundPIDs.join(', ')}`);
        }
        if (result.pid) {
          llmContentParts.push(`Process Group PGID: ${result.pid}`);
        }

        llmContent = llmContentParts.join('\n');
      }

      let returnDisplay: string | AnsiOutput = '';
      if (this.context.config.getDebugMode()) {
        returnDisplay = llmContent;
      } else {
        if (this.params.is_background || result.backgrounded) {
          returnDisplay = `Command moved to background (PID: ${result.pid}). Output hidden. Press Ctrl+B to view.`;
        } else if (result.aborted) {
          const cancelMsg = timeoutMessage || 'Command cancelled by user.';
          if (result.output.trim()) {
            returnDisplay = `${cancelMsg}\n\nOutput before cancellation:\n${result.output}`;
          } else {
            returnDisplay = cancelMsg;
          }
        } else if (result.output.trim() || result.ansiOutput) {
          returnDisplay =
            result.ansiOutput && result.ansiOutput.length > 0
              ? result.ansiOutput
              : result.output;
        } else {
          if (result.signal) {
            returnDisplay = `Command terminated by signal: ${result.signal}`;
          } else if (result.error) {
            returnDisplay = `Command failed: ${getErrorMessage(result.error)}`;
          } else if (result.exitCode !== null && result.exitCode !== 0) {
            returnDisplay = `Command exited with code: ${result.exitCode}`;
          }
          // If output is empty and command succeeded (code 0, no error/signal/abort),
          // returnDisplay will remain empty, which is fine.
        }
      }

      const taintAnalysis = this.getTaintAnalysis();
      const taintNoticeApplies =
        taintAnalysis.flags.length > 0 &&
        this.isTaintTrustEffective(taintAnalysis);
      if (taintNoticeApplies) {
        const trustedCommands =
          taintAnalysis.roots.length === 1
            ? `"${taintAnalysis.roots[0]}"`
            : taintAnalysis.roots.join(', ') || 'shell';
        returnDisplay = appendTaintNotice(
          returnDisplay,
          `⚠️ Untrusted flags allowed by session trust for ${trustedCommands}: ${taintAnalysis.flags.join(', ')}\n` +
            'Trust is scoped to this session; a new session will ask again.',
        );
      }

      // Heuristic Sandbox Denial Detection
      if (
        !!result.error ||
        !!result.signal ||
        (result.exitCode !== undefined && result.exitCode !== 0) ||
        result.aborted
      ) {
        const sandboxDenial =
          this.context.config.sandboxManager.parseDenials(result);
        if (sandboxDenial) {
          const strippedCommand = stripShellWrapper(this.params.command);
          const rootCommands = getCommandRoots(strippedCommand).filter(
            (r) => r !== 'shopt',
          );
          const rootCommandDisplay =
            rootCommands.length > 0 ? rootCommands[0] : 'shell';

          const readPaths = new Set(
            this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem?.read || [],
          );
          const writePaths = new Set(
            this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem?.write || [],
          );

          // Proactive permission suggestions for Node ecosystem tools
          if (this.context.config.getSandboxEnabled()) {
            const proactive =
              await getProactiveToolSuggestions(rootCommandDisplay);
            if (proactive) {
              if (proactive.network) {
                sandboxDenial.network = true;
              }
              if (proactive.fileSystem?.read) {
                for (const p of proactive.fileSystem.read) {
                  readPaths.add(p);
                }
              }
              if (proactive.fileSystem?.write) {
                for (const p of proactive.fileSystem.write) {
                  writePaths.add(p);
                }
              }
            }
          }

          if (sandboxDenial.filePaths) {
            for (const p of sandboxDenial.filePaths) {
              try {
                // Find an existing parent directory to add instead of a non-existent file
                let currentPath = p;
                if (currentPath.startsWith('~')) {
                  currentPath = path.join(os.homedir(), currentPath.slice(1));
                }
                try {
                  if (
                    fs.existsSync(currentPath) &&
                    fs.statSync(currentPath).isFile()
                  ) {
                    currentPath = path.dirname(currentPath);
                  }
                } catch {
                  /* ignore */
                }
                while (currentPath.length > 1) {
                  if (fs.existsSync(currentPath)) {
                    const mode = this.context.config.getApprovalMode();
                    const isReadonlyMode =
                      this.context.config.sandboxPolicyManager.getModeConfig(
                        mode,
                      )?.readonly ?? false;
                    const isAllowed =
                      this.context.config.isPathAllowed(currentPath);

                    if (!isAllowed || isReadonlyMode) {
                      writePaths.add(currentPath);
                      readPaths.add(currentPath);
                    }
                    break;
                  }
                  currentPath = path.dirname(currentPath);
                }
              } catch {
                // ignore
              }
            }
          }

          const simplifiedRead = this.simplifyPaths(readPaths);
          const simplifiedWrite = this.simplifyPaths(writePaths);

          const additionalPermissions = {
            network:
              sandboxDenial.network ||
              this.params[PARAM_ADDITIONAL_PERMISSIONS]?.network ||
              undefined,
            fileSystem:
              simplifiedRead.length > 0 || simplifiedWrite.length > 0
                ? {
                    read: simplifiedRead,
                    write: simplifiedWrite,
                  }
                : undefined,
          };

          const originalReadSize =
            this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem?.read
              ?.length || 0;
          const originalWriteSize =
            this.params[PARAM_ADDITIONAL_PERMISSIONS]?.fileSystem?.write
              ?.length || 0;
          const originalNetwork =
            !!this.params[PARAM_ADDITIONAL_PERMISSIONS]?.network;

          const newReadSize =
            additionalPermissions.fileSystem?.read?.length || 0;
          const newWriteSize =
            additionalPermissions.fileSystem?.write?.length || 0;
          const newNetwork = !!additionalPermissions.network;

          const hasNewPermissions =
            newReadSize > originalReadSize ||
            newWriteSize > originalWriteSize ||
            (!originalNetwork && newNetwork);

          if (hasNewPermissions) {
            const confirmationDetails = {
              type: 'sandbox_expansion',
              title: 'Sandbox Expansion Request',
              command: this.params.command,
              rootCommand: rootCommandDisplay,
              additionalPermissions,
            };

            return {
              llmContent: 'Sandbox expansion required',
              returnDisplay,
              error: {
                type: ToolErrorType.SANDBOX_EXPANSION_REQUIRED,
                message: JSON.stringify(confirmationDetails),
              },
            };
          }
          // If no new permissions were found by heuristic, do not intercept.
          // Just return the normal execution error so the LLM can try providing explicit paths itself.
        }
      }

      const summarizeConfig =
        this.context.config.getSummarizeToolOutputConfig();
      const executionError = result.error
        ? {
            error: {
              message: result.error.message,
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : {};
      if (summarizeConfig && summarizeConfig[SHELL_TOOL_NAME]) {
        const summary = await summarizeToolOutput(
          this.context.config,
          { model: 'summarizer-shell' },
          llmContent,
          this.context.geminiClient,
          signal,
        );
        return {
          llmContent: wrapUntrusted(summary),
          returnDisplay,
          ...executionError,
        };
      }

      const displayResultSummary = result.backgrounded
        ? `PID: ${result.pid}`
        : result.exitCode !== null && result.exitCode !== 0
          ? `Exit Code: ${result.exitCode}`
          : undefined;

      return {
        llmContent: wrapUntrusted(llmContent),
        display: {
          name: 'Shell',
          description: this.getDescription(),
          resultSummary: displayResultSummary,
          result:
            typeof returnDisplay === 'string'
              ? { type: 'text', text: returnDisplay }
              : // TODO: Add support for terminal display type (AnsiOutput)
                undefined,
        },
        returnDisplay,
        data,
        ...executionError,
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (trailingFlushTimer) {
        clearTimeout(trailingFlushTimer);
        trailingFlushTimer = null;
      }
      signal.removeEventListener('abort', onAbort);
      timeoutController.signal.removeEventListener('abort', onAbort);

      // Only clean up if NOT running in background.
      // Background processes transfer ownership of the temp directory to
      // ShellExecutionService, which removes it once the process exits.
      if (!isBackgrounded) {
        if (tempFilePath) {
          try {
            await fsPromises.unlink(tempFilePath);
          } catch {
            // Ignore errors during unlink
          }
        }
        if (tempDir) {
          try {
            await fsPromises.rm(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore errors during rm
          }
        }
      }
    }
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static readonly Name = SHELL_TOOL_NAME;

  constructor(
    private readonly context: AgentLoopContext,
    messageBus: MessageBus,
  ) {
    void initializeShellParsers().catch(() => {
      // Errors are surfaced when parsing commands.
    });
    const definition = getShellDefinition(
      context.config.isInteractiveShellEnabled(),
      context.config.getEnableShellOutputEfficiency(),
      context.config.getSandboxEnabled(),
    );
    super(
      ShellTool.Name,
      'Shell',
      definition.base.description!,
      Kind.Execute,
      definition.base.parametersJsonSchema,
      messageBus,
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }

    if (params.dir_path) {
      const resolvedPath = path.resolve(
        this.context.config.getTargetDir(),
        params.dir_path,
      );
      return this.context.config.validatePathAccess(resolvedPath);
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
    messageBus: MessageBus,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(
      this.context,
      params,
      messageBus,
      _toolName,
      _toolDisplayName,
    );
  }

  override getSchema(modelId?: string) {
    const definition = getShellDefinition(
      this.context.config.isInteractiveShellEnabled(),
      this.context.config.getEnableShellOutputEfficiency(),
      this.context.config.getSandboxEnabled(),
    );
    return resolveToolDeclaration(definition, modelId);
  }
}
