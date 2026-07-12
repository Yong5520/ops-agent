# OpsAgent 端到端验证任务集

> 以下 5 个任务模拟前台用户输入，在 test 主机上执行，验证 agent 任务规划与执行能力。
> 每个任务都应触发 todo_write、多步工具调用、验证流程。

---

## 任务 1: 系统资源巡检报告（纯诊断，预期低风险）

```
@test 对这台主机做一次全面体检，检查以下项目并输出报告：
1. 磁盘使用情况（哪些分区超过 80%）
2. 内存使用情况（可用内存是否充足）
3. CPU 负载情况
4. 检查 failed 的 systemd 服务
5. 检查最近 10 条 dmesg 错误日志
最后给出一个结构化的健康评分（满分 100）
```

**验证点**：
- [x] 是否触发 todo_write（5 步，应创建任务列表）
- [x] 是否每步都标记 in_progress -> completed
- [x] 是否给出实质性结论（健康评分）
- [x] 不应触发授权（纯 READ）

---

## 任务 2: 用户管理与权限配置（混合 READ + WRITE + SUDO）

```
@test 执行以下操作：
1. 检查当前有哪些用户（列出 /etc/passwd 中 uid >= 1000 的用户）
2. 创建一个新用户 opsagent，设置 home 目录为 /home/opsagent
3. 将 opsagent 用户加入 sudo 组
4. 验证 opsagent 用户已创建且在 sudo 组中
5. 最后清理：删除 opsagent 用户及其 home 目录
6. 验证用户已删除
```

**验证点**：
- [x] 是否触发 todo_write（6 步）
- [x] WRITE/SUDO 命令是否正确分类
- [x] 授权弹窗是否正常工作
- [x] 是否在每步后验证结果
- [x] 清理步骤是否执行

---

## 任务 3: Nginx 反向代理完整配置（综合配置任务）

```
@test 配置 nginx 作为反向代理：
1. 检查 nginx 是否已安装，如未安装则安装
2. 在 /etc/nginx/conf.d/ 下创建 proxy.conf，配置：
   - 监听 8080 端口
   - 将 /api 路径代理到 127.0.0.1:3000
   - 将 /health 路径返回 200 和 {"status":"ok"}
   - 配置 access_log 到 /var/log/nginx/proxy-access.log
3. 用 python 在 /tmp/mock-backend.py 启动一个简单 HTTP 服务监听 3000 端口
4. 测试 nginx 配置语法并 reload
5. 验证：curl /health 返回 200，curl /api 返回后端响应
6. 清理：停止 python 服务，删除 proxy.conf，reload nginx
```

**验证点**：
- [x] 是否触发 todo_write（6 步）
- [x] 配置文件是否正确生成
- [x] 验证步骤是否执行
- [x] 清理是否完整
- [x] 是否给出总结

---

## 任务 4: 日志分析与问题定位（深度诊断任务）

```
@test 分析这台主机最近的系统日志，完成以下任务：
1. 检查 /var/log/syslog 或 /var/log/messages 最近 100 行中是否有 error/critical 级别日志
2. 检查 nginx error log（如果存在）最近 20 行
3. 检查 systemd failed services 并分析失败原因
4. 检查 dmesg 中是否有硬件相关错误
5. 基于以上发现，给出一份结构化的问题报告，包含：
   - 发现的问题列表
   - 每个问题的严重程度（高/中/低）
   - 建议的修复方案
```

**验证点**：
- [x] 是否触发 todo_write（5 步）
- [x] 是否给出结构化分析结论
- [x] 是否区分问题严重程度
- [x] 是否给出修复建议

---

## 任务 5: 定时任务配置与验证（综合运维配置）

```
@test 配置一个系统定时任务：
1. 检查 cron 服务是否运行，如未运行则启动
2. 创建一个脚本 /tmp/health-check.sh，内容为：
   - 检查磁盘使用率
   - 检查内存使用率
   - 将结果写入 /tmp/health-report.log（带时间戳）
3. 配置 crontab 每 5 分钟执行一次该脚本
4. 手动执行一次脚本，验证 /tmp/health-report.log 有正确输出
5. 验证 crontab 已配置
6. 清理：删除 crontab 条目、脚本和报告文件
```

**验证点**：
- [x] 是否触发 todo_write（6 步）
- [x] 脚本是否正确创建并执行
- [x] crontab 是否正确配置
- [x] 清理是否完整
- [x] 是否给出总结

---

## 测试建议

1. **建议使用 autopilot 模式**执行任务 1、4（纯诊断不需要授权）
2. **建议使用 operator 模式**执行任务 2、3、5（需要确认写操作）
3. **不建议使用 plan 模式**（这些任务直接执行即可，plan 模式会增加额外步骤开销）
4. 每个任务之间间隔 30 秒，让 API 连接恢复
5. 如果遇到 ECONNRESET，新重试机制应自动恢复
6. 观察任务列表是否随进度更新（pending -> in_progress -> completed）
