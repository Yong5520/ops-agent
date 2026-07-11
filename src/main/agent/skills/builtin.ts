import type { Skill } from './types.js';

// Built-in diagnostic skills. Each skill's promptFragment is injected into
// the system prompt when enabled, giving the AI structured domain knowledge
// and a diagnostic procedure to follow.
//
// Prompt fragments are kept concise (<500 tokens each) to control system
// prompt size. Only enabled skills are injected.

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'system-diagnosis',
    displayName: '系统全面诊断',
    description: '磁盘、内存、CPU、网络、进程全面检查',
    triggerKeywords: ['系统', '诊断', '体检', 'system', 'diagnosis', 'health'],
    enabledByDefault: true,
    promptFragment: `## 技能：系统全面诊断

当用户要求"全面检查"或"系统诊断"时，按以下顺序执行：

1. **磁盘**：\`df -h\` 查看使用率，\`df -i\` 查看 inode。使用率 >85% 需进一步排查大文件。
2. **内存**：\`free -m\` 查看总内存/可用/swap。可用 <20% 需排查进程内存占用。
3. **CPU**：\`uptime\` 查看负载，\`top -bn1 | head -20\` 查看 CPU 占用最高的进程。负载 >CPU 核数需关注。
4. **进程**：\`ps aux --sort=-%mem | head -10\` 和 \`ps aux --sort=-%cpu | head -10\`。
5. **网络**：\`ss -tlnp\` 查看监听端口，\`ss -tn state established\` 查看活动连接。
6. **系统日志**：\`journalctl -p err --since "1 hour ago" --no-pager | tail -30\`。
7. **内核**：\`dmesg --level=err,warn --time-format reltime | tail -20\`。

完成后给出结构化总结：哪些指标异常、可能的原因、建议操作。`,
  },
  {
    name: 'nginx-diagnosis',
    displayName: 'Nginx 诊断',
    description: '配置测试、状态、日志分析、上游检查',
    triggerKeywords: ['nginx', '502', '504', '网关', 'upstream'],
    enabledByDefault: true,
    promptFragment: `## 技能：Nginx 诊断

当用户报告 nginx 相关问题（502/504/服务异常）时：

1. **配置测试**：\`nginx -t\` 检查配置语法。
2. **服务状态**：\`systemctl status nginx\` 查看是否运行、最近事件。
3. **进程**：\`ps aux | grep nginx\` 确认 worker 进程数量。
4. **监听端口**：\`ss -tlnp | grep nginx\` 确认 80/443 监听。
5. **错误日志**：\`tail -50 /var/log/nginx/error.log\`，重点看 upstream timeout、connection refused。
6. **访问日志**：\`tail -50 /var/log/nginx/access.log\`，关注 5xx 状态码。
7. **上游检查**：如果配置了 upstream，\`curl -s -o /dev/null -w "%{http_code}" http://upstream:port/health\`。

常见问题：
- 502 Bad Gateway：上游服务未启动或拒绝连接
- 504 Gateway Timeout：上游响应超时
- worker_connections not enough：连接数配置过小`,
  },
  {
    name: 'docker-diagnosis',
    displayName: 'Docker 诊断',
    description: '容器状态、资源、日志、网络',
    triggerKeywords: ['docker', '容器', 'container', '镜像', 'image'],
    enabledByDefault: true,
    promptFragment: `## 技能：Docker 诊断

当用户报告 docker/容器相关问题时：

1. **守护进程**：\`systemctl status docker\` 确认运行状态。
2. **容器列表**：\`docker ps -a\` 查看所有容器（含已停止）。
3. **资源使用**：\`docker stats --no-stream\` 查看 CPU/内存/网络。
4. **磁盘**：\`docker system df\` 查看镜像/容器/卷占用。
5. **容器日志**：\`docker logs --tail 50 <container>\`，关注 ERROR/Exception。
6. **容器详情**：\`docker inspect <container>\` 查看配置、网络、挂载。
7. **网络**：\`docker network ls\` 和 \`docker network inspect <network>\`。

常见问题：
- 容器频繁重启：检查日志中的 OOM、应用崩溃
- 磁盘满：\`docker system prune\` 清理未使用资源
- 网络不通：检查 bridge 网络和端口映射`,
  },
  {
    name: 'systemd-diagnosis',
    displayName: 'Systemd 诊断',
    description: '失败单元、journal、依赖树',
    triggerKeywords: ['systemd', 'systemctl', 'service', '服务', 'journal'],
    enabledByDefault: true,
    promptFragment: `## 技能：Systemd 诊断

当用户报告服务管理相关问题时：

1. **失败单元**：\`systemctl --failed\` 列出所有失败的服务。
2. **服务状态**：\`systemctl status <unit>\` 查看运行状态和最近日志。
3. **详细日志**：\`journalctl -u <unit> --since "1 hour ago" --no-pager | tail -50\`。
4. **依赖关系**：\`systemctl list-dependencies <unit>\` 查看依赖链。
5. **启动配置**：\`systemctl cat <unit>\` 查看单元文件内容。
6. **启动日志**：\`journalctl -b -u <unit> --no-pager | tail -30\` 查看本次启动的日志。

常见操作（需 Operator 模式确认）：
- 重启服务：\`systemctl restart <unit>\`
- 重新加载：\`systemctl reload <unit>\`（不中断连接）
- 查看启动顺序：\`systemd-analyze blame | head -10\``,
  },
  {
    name: 'mysql-diagnosis',
    displayName: 'MySQL 诊断',
    description: '进程、慢查询、连接数、复制状态',
    triggerKeywords: ['mysql', 'mariadb', '数据库', '慢查询', 'slow query'],
    enabledByDefault: false,
    promptFragment: `## 技能：MySQL 诊断

当用户报告 MySQL 相关问题时：

1. **进程**：\`ps aux | grep mysql\` 确认运行。
2. **服务状态**：\`systemctl status mysql\` 或 \`systemctl status mysqld\`。
3. **连接数**：\`mysql -e "SHOW STATUS LIKE 'Threads_connected';"\` 和 \`SHOW VARIABLES LIKE 'max_connections';\`
4. **慢查询**：检查 \`SHOW VARIABLES LIKE 'slow_query_log%';\`，若开启查看日志文件。
5. **进程列表**：\`mysql -e "SHOW PROCESSLIST;"\` 查看活动查询。
6. **复制状态**（如适用）：\`mysql -e "SHOW SLAVE STATUS\\G;"\` 查看 IO/SQL 线程。

注意：连接 MySQL 需要凭据，提示用户提供或检查 ~/.my.cnf。`,
  },
  {
    name: 'redis-diagnosis',
    displayName: 'Redis 诊断',
    description: 'ping、内存、slowlog、客户端',
    triggerKeywords: ['redis', '缓存', 'cache'],
    enabledByDefault: false,
    promptFragment: `## 技能：Redis 诊断

当用户报告 Redis 相关问题时：

1. **连通性**：\`redis-cli ping\` 应返回 PONG。
2. **内存**：\`redis-cli info memory\` 查看 used_memory、maxmemory、碎片率。
3. **慢日志**：\`redis-cli slowlog get 10\` 查看慢操作。
4. **客户端**：\`redis-cli info clients\` 查看连接数。
5. **键空间**：\`redis-cli info keyspace\` 查看各 DB 键数量。
6. **大键扫描**：\`redis-cli --bigkeys\`（生产环境慎用，使用 scan 模式）。

注意：如有密码需 \`redis-cli -a <password>\` 或使用 AUTH 命令。`,
  },
  {
    name: 'security-audit',
    displayName: '安全巡检',
    description: '防火墙、SSH 配置、用户权限、开放端口',
    triggerKeywords: ['安全', 'security', '防火墙', 'firewall', 'ssh', 'audit'],
    enabledByDefault: false,
    promptFragment: `## 技能：安全巡检

当用户要求安全检查时：

1. **防火墙**：\`iptables -L -n\` 或 \`ufw status\` 查看规则。
2. **SSH 配置**：\`grep -E "^(PermitRootLogin|PasswordAuthentication|Port)" /etc/ssh/sshd_config\`。
3. **开放端口**：\`ss -tlnp\` 查看所有监听端口。
4. **用户**：\`cat /etc/passwd | grep -v nologin | grep -v false\` 查看可登录用户。
5. **sudo 用户**：\`grep -r sudo /etc/sudoers /etc/sudoers.d/\`（需 sudo）。
6. **最近登录**：\`last -20\` 和 \`lastb -10\`（失败登录）。
7. **异常进程**：\`ps aux --sort=-%cpu | head -20\`。

建议项（不自动执行）：
- 禁用 root SSH 登录
- 限制密码登录为密钥
- 关闭不必要端口`,
  },
  {
    name: 'disk-full',
    displayName: '磁盘空间排查',
    description: '大文件、inode、日志清理',
    triggerKeywords: ['磁盘', 'disk', '空间', '满', 'full', 'no space'],
    enabledByDefault: true,
    promptFragment: `## 技能：磁盘空间排查

当用户报告磁盘满或空间不足时：

1. **整体使用**：\`df -h\` 查看各挂载点使用率。
2. **大目录**：\`du -sh /* 2>/dev/null | sort -rh | head -10\`，逐层深入。
3. **大文件**：\`find / -maxdepth 4 -size +500M 2>/dev/null | head -20\`。
4. **inode**：\`df -i\` 查看 inode 使用率（小文件过多导致 inode 满）。
5. **日志文件**：\`find /var/log -name "*.log" -exec du -sh {} \\; | sort -rh | head -10\`。
6. **已删除未释放**：\`lsof | grep deleted | head -10\`（进程持有已删除文件）。

清理建议（需用户确认）：
- 截断大日志：\`> /var/log/large.log\`
- 清理旧日志：\`journalctl --vacuum-time=7d\`
- 清理包缓存：\`apt clean\` / \`yum clean all\``,
  },
];
