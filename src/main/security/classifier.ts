import type { CommandType } from '../../shared/types.js';

// Classify a shell command as READ / WRITE / SUDO.
// Used by the safety mode engine to decide whether user confirmation
// is required before execution (e.g., Operator mode auto-runs READ,
// prompts for WRITE/SUDO).
//
// READ = does not modify files, does not restart services, does not
//        alter system state. Examples: ls, cat, ps, ip addr show.
// WRITE = modifies files, services, network, or system state.
// SUDO = any command prefixed with sudo or su (elevated privilege).

// Commands that only read system state - safe to auto-run in any mode.
// Dual-purpose commands (ip, route, arp, dpkg, rpm, sed, mount,
// ifconfig, apt, systemctl, docker, git, etc.) are NOT listed here;
// they are handled by DUAL_PURPOSE patterns or bespoke logic below.
const READ_COMMANDS = [
  // File inspection
  'ls',
  'll',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'locate',
  'tree',
  'du',
  'df',
  // Text processing (read-only on stdin/stdout; no in-place mutation)
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ack',
  'cut',
  'sort',
  'uniq',
  'tr',
  'column',
  'paste',
  'expand',
  'fold',
  // System inspection
  'ps',
  'top',
  'htop',
  'free',
  'uptime',
  'who',
  'w',
  'last',
  'id',
  'uname',
  'hostname',
  'arch',
  'lscpu',
  'lsmem',
  'lsblk',
  'lsusb',
  'lspci',
  'lsmod',
  'lsns',
  'lsof',
  // Hardware diagnostic / inspection (read-only)
  'nvidia-smi',
  'smartctl',
  'dmidecode',
  'lshw',
  'lsscsi',
  'sensors',
  'biosdecode',
  'hwinfo',
  'inxi',
  'sg_ses',
  'sg_inq',
  'sg_vpd',
  'lspci',
  // Network inspection (dual-purpose ip/ifconfig/route/arp handled separately)
  'ping',
  'traceroute',
  'tracepath',
  'dig',
  'nslookup',
  'host',
  'ss',
  'netstat',
  'curl',
  'wget',
  // Service inspection (dual-purpose systemctl/service handled separately)
  'journalctl',
  'dmesg',
  // Process / perf inspection
  'vmstat',
  'iostat',
  'mpstat',
  'sar',
  'pidstat',
  'strace',
  'ltrace',
  // Misc read-only
  'date',
  'time',
  'cal',
  'echo',
  'printf',
  'test',
  'true',
  'false',
  'env',
  'printenv',
  'which',
  'whereis',
  'type',
  'history',
  'man',
];

// Commands that modify system state - require confirmation in Operator mode.
const WRITE_COMMANDS = [
  // File modification
  'touch',
  'mkdir',
  'rmdir',
  'rm',
  'cp',
  'mv',
  'ln',
  'install',
  'chmod',
  'chown',
  'chattr',
  'truncate',
  'split',
  'rename',
  'tee',
  'dd',
  'shred',
  'mktemp',
  // File writing via redirection: handled separately by REDIRECTION_PATTERN
  // Power control
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  // User / permission
  'useradd',
  'usermod',
  'userdel',
  'groupadd',
  'groupmod',
  'groupdel',
  'passwd',
  'chage',
  'gpasswd',
  'visudo',
  // Network mutation
  'iptables',
  'nft',
  'firewall-cmd',
  'ufw',
  'ipset',
  // Filesystem mutation
  'mkfs',
  'mount',
  'umount',
  'fdisk',
  'parted',
  'resize2fs',
  'xfs_growfs',
  // Kernel
  'modprobe',
  'insmod',
  'rmmod',
  'sysctl',
];

// Subcommand patterns that disambiguate dual-purpose package managers.
const MUTATION_SUBCOMMANDS =
  /\b(install|remove|purge|upgrade|update|erase|reinstall|autoremove|clean|dist-upgrade)\b/i;

// Detect output redirection to a FILE (write).
// Excludes fd-to-fd redirections like 2>&1, 1>&2, >&- which redirect
// to another file descriptor rather than writing to a file.
// Matches: >file, >>file, 2>file, &>file, > file
// Rejects: 2>&1, 1>&2, >&2, 2>&-
const REDIRECTION_PATTERN = />>?(?!\s*&)\s*\S/;

// Redirect to /dev/null is a null-sink - suppresses output (commonly stderr
// via `2>/dev/null`) without modifying any file or system state. Such
// redirections must NOT force WRITE classification, otherwise read-only
// diagnostic pipelines like `lspci -vvv 2>/dev/null | grep ... | head` get
// misclassified as WRITE and force unnecessary approval in Operator mode.
// Empirically confirmed via audit_logs session d6372529 (2026-07-07).
const NULL_REDIRECTION_PATTERN = /\s*[&\d]*>>?\s*\/dev\/null\b/g;

// Shell metacharacters that can execute arbitrary commands or inject
// multi-line content. Their presence forces WRITE classification so
// Operator mode prompts for approval - even if the outer command name
// looks read-only (e.g., `cat <<EOF | bash`, `echo "$(rm -rf /)"`).
//
// - << (heredoc): injects multi-line content, often piped to a shell
// - <<< (here-string): single-line variant
// - <( ... ) (process substitution): executes a command, feeds as file
// - $( ... ) (command substitution): executes a command inline
// - ` ... ` (backtick substitution): legacy form of $()
const SHELL_METACHAR_PATTERN = /<<<?\s*['"]?-?\s*\w|<\([^)]+\)|\$\([^)]+\)|`[^`]+`/;

// Dual-purpose commands whose READ/WRITE nature depends on subcommand.
// If writePattern matches the full command, classify as WRITE; otherwise READ.
// Order does not matter; only one entry matches a given command name.
const DUAL_PURPOSE: Array<{ names: string[]; writePattern: RegExp }> = [
  // Package managers: install/remove/upgrade -> WRITE; list/show/search -> READ
  {
    names: ['apt', 'apt-get', 'yum', 'dnf', 'pip', 'pip3', 'npm', 'gem'],
    writePattern: MUTATION_SUBCOMMANDS,
  },
  // Service control: start/stop/restart/enable/disable -> WRITE; status/show -> READ
  {
    names: ['systemctl', 'service'],
    writePattern: /\s(start|stop|restart|reload|enable|disable|mask|unmask|set-default|edit)\b/i,
  },
  // Containers / orchestration: exec/run/create/rm/apply -> WRITE; ps/logs/inspect -> READ
  {
    names: ['docker', 'kubectl', 'crictl', 'ctr'],
    writePattern:
      /\b(exec|run|create|rm|rmi|stop|kill|pause|unpause|restart|start|apply|delete|edit|patch|replace|scale|rollout|cordon|uncordon|drain|taint|label|annotate)\b/i,
  },
  // Git: commit/push/merge/reset/checkout -> WRITE; status/log/diff -> READ
  {
    names: ['git'],
    writePattern:
      /\b(commit|push|merge|reset|clean|checkout|rebase|cherry-pick|revert|tag|branch|stash|drop|apply|pop|fetch|pull|clone|init|add|mv|rm|update-ref)\b/i,
  },
  // ip (iproute2): add/del/set/flush -> WRITE; show/list/get -> READ
  {
    names: ['ip'],
    writePattern: /\b(add|del|set|flush|update|append|replace|change)\b/i,
  },
  // route: add/del/flush -> WRITE; -n/print -> READ
  {
    names: ['route'],
    writePattern: /\b(add|del|delete|flush)\b/i,
  },
  // arp: -s/-d/--set/--delete -> WRITE; -a/-n -> READ
  {
    names: ['arp'],
    writePattern: /(\s-s\b|\s-d\b|--set\b|--delete\b)/i,
  },
  // dpkg: -i/-r/-P/--install/--remove/--purge/--configure -> WRITE; -l/-s/-L/-S -> READ
  {
    names: ['dpkg'],
    writePattern: /(\s-[irP]\b|--install\b|--remove\b|--purge\b|--configure\b|--unpack\b)/i,
  },
  // rpm: -i/-U/-F/-e/--install/--upgrade/--freshen/--erase -> WRITE; -q/-qa -> READ
  {
    names: ['rpm'],
    writePattern: /(\s-[iUFe]\b|--install\b|--upgrade\b|--freshen\b|--erase\b)/i,
  },
  // sed: -i / --in-place -> WRITE (modifies files in place); default -> READ
  {
    names: ['sed'],
    writePattern: /(\s-i\b|\s-i\S|--in-place\b)/i,
  },
  // find: -exec / -execdir / -ok -> WRITE (executes arbitrary commands); default -> READ
  {
    names: ['find'],
    writePattern: /\s(-exec|-execdir|-ok)\b/i,
  },
  // awk: system() / | getline / printf to pipe -> WRITE (can execute commands); default -> READ
  {
    names: ['awk', 'gawk', 'mawk'],
    writePattern: /(system\s*\(|\|\s*getline)/i,
  },
  // nvme: format/secure-erase/sanitize -> WRITE; list/smart-log/id-ctrl -> READ
  {
    names: ['nvme'],
    writePattern: /\b(format|secure-erase|sanitize|fw-download|fw-activate)\b/i,
  },
  // udevadm: trigger/control -> WRITE; info/monitor -> READ
  {
    names: ['udevadm'],
    writePattern: /\b(trigger|control)\b/i,
  },
];

// Severity ranking for pipe-chain classification.
// When a compound command (e.g., `cmd1 | cmd2`) is split into segments,
// each segment is classified independently and the highest severity wins.
// READ < WRITE < SUDO
const SEVERITY: Record<CommandType, number> = {
  READ: 0,
  WRITE: 1,
  SUDO: 2,
  BLOCKED: 3,
};

// Quote-aware split of compound commands by shell operators: |, ;, &&, ||, |&
// Respects single and double quotes so pipes inside strings like
// `grep "a|b"` or `echo 'a;b'` are NOT treated as chain operators.
function splitChain(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    // Track quote state - don't split when inside quotes
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      i++;
      continue;
    }

    // Only split when not inside quotes
    if (!inSingle && !inDouble) {
      // Two-char operators: &&, ||, |&
      if (ch === '&' && next === '&') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|' && next === '|') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
      if (ch === '|' && next === '&') {
        segments.push(current);
        current = '';
        i += 2;
        continue;
      }
      // Single-char operators: |, ;
      if (ch === '|') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
      if (ch === ';') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  if (current.trim()) segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Classify a single command segment (no pipe/chain operators).
// This is the core classification logic - handles sudo/su prefix,
// redirection, shell metacharacters, and command-name lookup.
function classifySegment(trimmed: string): CommandType {
  // sudo prefix -> SUDO (regardless of what follows)
  if (/^sudo(\s|$)/i.test(trimmed)) return 'SUDO';

  // su -c '...' -> SUDO equivalent
  if (/^su(\s|$)/i.test(trimmed)) return 'SUDO';

  // Output redirection to a file -> WRITE.
  // Exception: redirection only to /dev/null is a null-sink (no state
  // change). Strip all /dev/null redirects; if any real file redirect
  // remains -> WRITE, otherwise fall through to command-name classification.
  // Keeps read-only pipelines like `lspci -vvv 2>/dev/null | grep ... | head`
  // classified as READ. (Empirically confirmed via audit_logs session d6372529.)
  if (REDIRECTION_PATTERN.test(trimmed)) {
    const withoutNull = trimmed.replace(NULL_REDIRECTION_PATTERN, '');
    if (REDIRECTION_PATTERN.test(withoutNull)) return 'WRITE';
  }

  // Shell metacharacters (heredoc, process substitution, command
  // substitution) -> WRITE. These can execute arbitrary commands or
  // inject multi-line content; forcing approval gives the user a chance
  // to inspect. The engine's extractSubshellCommands further checks the
  // inner content against blocked rules.
  if (SHELL_METACHAR_PATTERN.test(trimmed)) return 'WRITE';

  // Tokenize for command-name and argument-structure checks
  const tokens = trimmed.split(/\s+/);
  const firstTokenMatch = tokens[0].match(/^([\w./-]+)/);
  if (!firstTokenMatch) return 'READ';
  const firstToken = firstTokenMatch[1].toLowerCase();
  // Strip path prefix: /usr/bin/ls -> ls
  const cmdName = firstToken.split('/').pop() ?? firstToken;

  // Dual-purpose commands: subcommand-pattern based
  for (const dual of DUAL_PURPOSE) {
    if (dual.names.includes(cmdName)) {
      return dual.writePattern.test(trimmed) ? 'WRITE' : 'READ';
    }
  }

  // mount: bare `mount` / `mount -l` -> READ (list mounts); any other args -> WRITE
  if (cmdName === 'mount') {
    if (tokens.length === 1) return 'READ';
    const arg = tokens[1];
    if (['-l', '--list', '-h', '--help', '-V', '--version'].includes(arg)) return 'READ';
    return 'WRITE';
  }

  // ifconfig: bare or `ifconfig IFACE` (<=2 tokens) -> READ; more args -> WRITE
  if (cmdName === 'ifconfig') {
    return tokens.length <= 2 ? 'READ' : 'WRITE';
  }

  if (WRITE_COMMANDS.includes(cmdName)) return 'WRITE';
  if (READ_COMMANDS.includes(cmdName)) return 'READ';

  // Default unknown to WRITE for safety (Operator mode will prompt)
  return 'WRITE';
}

export function classifyCommand(command: string): CommandType {
  const trimmed = command.trim();
  if (!trimmed) return 'READ';

  // Split compound commands by chain operators (|, ;, &&, ||) with
  // quote awareness. Each segment is classified independently; the
  // highest severity wins. This ensures `nvidia-smi -q | grep -i "..."`
  // is classified as READ (both segments are READ), while
  // `ls | sed -i 's/a/b/'` is WRITE (sed -i segment is WRITE).
  const segments = splitChain(trimmed);
  if (segments.length === 0) return 'READ';
  if (segments.length === 1) return classifySegment(segments[0]);

  let maxType: CommandType = 'READ';
  for (const segment of segments) {
    const segType = classifySegment(segment);
    if (SEVERITY[segType] > SEVERITY[maxType]) {
      maxType = segType;
    }
  }
  return maxType;
}
