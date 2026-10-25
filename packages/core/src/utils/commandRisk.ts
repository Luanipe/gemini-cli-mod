/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal command-aware execution-risk metadata.
 *
 * The generic untrusted-flag detector is intentionally conservative. This
 * module answers a narrower, session-trust question: if a command is already
 * trusted for the session, does this invocation use a flag that can execute
 * code (and should therefore still be confirmed)?
 */
export interface CommandExecutionProfile {
  /** Flags whose value is executed, evaluated, or used as a program. */
  executionFlags: ReadonlySet<string>;
  /**
   * Whether a bare path argument is executed by the command (interpreters and
   * shells), as opposed to being searched or read (rg, grep, find, git).
   */
  executesBarePathArgs?: boolean;
  /**
   * Whether flags are case-insensitive (PowerShell, cmd.exe). Short flags stay
   * case-sensitive everywhere else (for example `git -C` vs `git -c`).
   */
  caseInsensitiveFlags?: boolean;
}

const EXECUTION_PROFILES: Readonly<Record<string, CommandExecutionProfile>> = {
  rg: {
    executionFlags: new Set(['--pre', '--hostname-bin']),
  },
  grep: {
    executionFlags: new Set(),
  },
  egrep: {
    executionFlags: new Set(),
  },
  fgrep: {
    executionFlags: new Set(),
  },
  find: {
    executionFlags: new Set(['-exec', '-execdir', '-ok', '-okdir']),
  },
  git: {
    executionFlags: new Set([
      '-c',
      '--exec-path',
      '--upload-pack',
      '--receive-pack',
      '--config-env',
    ]),
  },
  node: {
    executionFlags: new Set([
      '-e',
      '--eval',
      '-p',
      '--print',
      '-r',
      '--require',
      '--import',
      '--loader',
      '--experimental-loader',
    ]),
    executesBarePathArgs: true,
  },
  python: {
    executionFlags: new Set(['-c', '-m', '--module']),
    executesBarePathArgs: true,
  },
  python3: {
    executionFlags: new Set(['-c', '-m', '--module']),
    executesBarePathArgs: true,
  },
  bash: {
    executionFlags: new Set(['-c', '-lc', '-cl', '--command']),
    executesBarePathArgs: true,
  },
  sh: {
    executionFlags: new Set(['-c', '-lc', '-cl', '--command']),
    executesBarePathArgs: true,
  },
  zsh: {
    executionFlags: new Set(['-c', '-lc', '-cl', '--command']),
    executesBarePathArgs: true,
  },
  dash: {
    executionFlags: new Set(['-c', '-lc', '-cl', '--command']),
    executesBarePathArgs: true,
  },
  ksh: {
    executionFlags: new Set(['-c', '-lc', '-cl', '--command']),
    executesBarePathArgs: true,
  },
  perl: {
    executionFlags: new Set(['-e', '-E', '-M', '-m']),
    executesBarePathArgs: true,
  },
  ruby: {
    executionFlags: new Set(['-e', '-E', '-r']),
    executesBarePathArgs: true,
  },
  php: {
    executionFlags: new Set(['-r', '-f']),
    executesBarePathArgs: true,
  },
  powershell: {
    executionFlags: new Set(['-c', '-command', '-encodedcommand', '-enc']),
    executesBarePathArgs: true,
    caseInsensitiveFlags: true,
  },
  pwsh: {
    executionFlags: new Set(['-c', '-command', '-encodedcommand', '-enc']),
    executesBarePathArgs: true,
    caseInsensitiveFlags: true,
  },
  cmd: {
    executionFlags: new Set(['/c', '/k']),
    executesBarePathArgs: true,
    caseInsensitiveFlags: true,
  },
  deno: {
    executionFlags: new Set(),
    executesBarePathArgs: true,
  },
  bun: {
    executionFlags: new Set(['-e', '--eval']),
    executesBarePathArgs: true,
  },
  tsx: {
    executionFlags: new Set(['-e', '--eval']),
    executesBarePathArgs: true,
  },
  'ts-node': {
    executionFlags: new Set(['-e', '--eval']),
    executesBarePathArgs: true,
  },
};

function getCommandBaseName(root: string): string {
  const normalized = root.trim().replace(/\\/g, '/');
  const base = normalized.split('/').filter(Boolean).pop() ?? normalized;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

export function getCommandExecutionProfile(
  root: string,
): CommandExecutionProfile | undefined {
  const base = getCommandBaseName(root);
  return EXECUTION_PROFILES[base] ?? EXECUTION_PROFILES[root.toLowerCase()];
}

function getFlagName(flag: string): string {
  const separator = flag.indexOf('=');
  return separator === -1 ? flag : flag.slice(0, separator);
}

function looksLikeExecutablePath(flag: string): boolean {
  return (
    flag.startsWith('/') ||
    flag.startsWith('./') ||
    flag.startsWith('../') ||
    /^[a-zA-Z]:[\\/]/.test(flag) ||
    /\.(sh|bash|zsh|ps1|bat|cmd|exe|py|pl|rb|php|js|mjs|cjs|ts)$/i.test(flag)
  );
}

function matchesExecutionFlag(
  profile: CommandExecutionProfile,
  flag: string,
): boolean {
  const rawName = getFlagName(flag);
  const name = profile.caseInsensitiveFlags ? rawName.toLowerCase() : rawName;

  if (profile.executionFlags.has(name)) {
    return true;
  }

  // Case-insensitive profiles (PowerShell, cmd) are matched by exact flag
  // name only; their long flags contain letters such as `c` that would
  // otherwise be mistaken for a POSIX short-flag cluster.
  if (profile.caseInsensitiveFlags) {
    return false;
  }

  // Long flags with attached values were already reduced to their name.
  if (name.startsWith('--')) {
    return false;
  }

  if (!name.startsWith('-')) {
    return false;
  }

  const shortChars = name.slice(1);
  for (const exec of profile.executionFlags) {
    const normalizedExec = profile.caseInsensitiveFlags
      ? exec.toLowerCase()
      : exec;
    if (!normalizedExec.startsWith('-') || normalizedExec.startsWith('--')) {
      continue;
    }

    const execChars = normalizedExec.slice(1);
    if (execChars.length === 1) {
      // Handles clusters such as `bash -ec` and attached values such as
      // `git -ccore.pager=evil`.
      if (shortChars.includes(execChars)) {
        return true;
      }
    } else if (name.startsWith(normalizedExec)) {
      return true;
    }
  }

  return false;
}

/**
 * Returns true when any of the untrusted flags can execute code for one of the
 * given root commands.
 */
export function hasExecutionFlag(
  roots: readonly string[],
  flags: readonly string[],
): boolean {
  if (flags.length === 0) {
    return false;
  }

  for (const root of roots) {
    const profile = getCommandExecutionProfile(root);
    if (!profile) {
      // A wrapper that resolves to a script/binary path still executes it.
      if (looksLikeExecutablePath(root)) {
        return true;
      }
      continue;
    }

    for (const flag of flags) {
      if (matchesExecutionFlag(profile, flag)) {
        return true;
      }
      if (profile.executesBarePathArgs && looksLikeExecutablePath(flag)) {
        return true;
      }
    }
  }

  return false;
}
