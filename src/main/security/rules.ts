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
      '(^|\\s|;|&&|\\|\\|)\\s*(eval|bash\\s+-c)\\s+.*\\b(rm|shutdown|reboot|mkfs|dd|halt|poweroff|passwd)\\b',
    reason: '禁止通过 eval/bash -c 间接执行危险命令',
    severity: 'critical',
  },
  {
    pattern: '(base64\\s+-d|gunzip|gzip\\s+-d)\\s*.*\\|\\s*(bash|sh)\\b',
    reason: '禁止通过编码/压缩绕过执行命令 (encoded command execution)',
    severity: 'critical',
  },
];
