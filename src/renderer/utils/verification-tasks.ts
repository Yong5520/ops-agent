/**
 * End-to-end verification script for OpsAgent.
 *
 * Sends simulated user messages to the agent loop via IPC, testing complex
 * multi-step tasks on the test host. Designed to be run from the main process
 * (Electron dev tools console or a dedicated test runner).
 *
 * Usage (in renderer dev tools console):
 *   await window.__runVerificationTasks()
 *
 * Or paste into the ChatPage message input one by one.
 */

/* eslint-disable no-console */

// Verification tasks - each is a simulated user message
const VERIFICATION_TASKS = [
  {
    name: '系统资源巡检报告',
    message:
      '@test 对这台主机做一次全面体检，检查以下项目并输出报告：\n1. 磁盘使用情况（哪些分区超过 80%）\n2. 内存使用情况（可用内存是否充足）\n3. CPU 负载情况\n4. 检查 failed 的 systemd 服务\n5. 检查最近 10 条 dmesg 错误日志\n最后给出一个结构化的健康评分（满分 100）',
    expectedSteps: 5,
    riskLevel: 'low',
  },
  {
    name: '用户管理与权限配置',
    message:
      '@test 执行以下操作：\n1. 检查当前有哪些用户（列出 /etc/passwd 中 uid >= 1000 的用户）\n2. 创建一个新用户 opsagent，设置 home 目录为 /home/opsagent\n3. 将 opsagent 用户加入 sudo 组\n4. 验证 opsagent 用户已创建且在 sudo 组中\n5. 清理：删除 opsagent 用户及其 home 目录\n6. 验证用户已删除',
    expectedSteps: 6,
    riskLevel: 'medium',
  },
  {
    name: 'Nginx 反向代理完整配置',
    message:
      '@test 配置 nginx 作为反向代理：\n1. 检查 nginx 是否已安装，如未安装则安装\n2. 在 /etc/nginx/conf.d/ 下创建 proxy.conf，配置监听 8080 端口，将 /api 代理到 127.0.0.1:3000，将 /health 返回 200 和 {"status":"ok"}\n3. 用 python 在 /tmp/mock-backend.py 启动 HTTP 服务监听 3000 端口\n4. 测试 nginx 配置语法并 reload\n5. 验证：curl /health 返回 200，curl /api 返回后端响应\n6. 清理：停止 python 服务，删除 proxy.conf，reload nginx',
    expectedSteps: 6,
    riskLevel: 'high',
  },
  {
    name: '日志分析与问题定位',
    message:
      '@test 分析这台主机最近的系统日志，完成以下任务：\n1. 检查 /var/log/syslog 或 /var/log/messages 最近 100 行中是否有 error/critical 级别日志\n2. 检查 nginx error log（如果存在）最近 20 行\n3. 检查 systemd failed services 并分析失败原因\n4. 检查 dmesg 中是否有硬件相关错误\n5. 基于以上发现，给出一份结构化的问题报告，包含问题列表、严重程度、修复建议',
    expectedSteps: 5,
    riskLevel: 'low',
  },
  {
    name: '定时任务配置与验证',
    message:
      '@test 配置一个系统定时任务：\n1. 检查 cron 服务是否运行，如未运行则启动\n2. 创建脚本 /tmp/health-check.sh，检查磁盘和内存使用率并写入 /tmp/health-report.log\n3. 配置 crontab 每 5 分钟执行一次该脚本\n4. 手动执行一次脚本，验证输出\n5. 验证 crontab 已配置\n6. 清理：删除 crontab 条目、脚本和报告文件',
    expectedSteps: 6,
    riskLevel: 'medium',
  },
];

// Export for use in dev tools console
if (typeof window !== 'undefined') {
  (window as any).__runVerificationTasks = async function () {
    console.log('=== OpsAgent 端到端验证任务 ===');
    console.log(`共 ${VERIFICATION_TASKS.length} 个任务`);
    console.log('请将以下任务逐一粘贴到对话框中发送：\n');

    for (const task of VERIFICATION_TASKS) {
      console.log(`--- 任务: ${task.name} ---`);
      console.log(`预期步骤: ${task.expectedSteps}`);
      console.log(`风险等级: ${task.riskLevel}`);
      console.log(`消息内容:`);
      console.log(task.message);
      console.log('\n---\n');
    }

    console.log('提示:');
    console.log('1. 建议使用 autopilot 模式执行任务 1、4');
    console.log('2. 建议使用 operator 模式执行任务 2、3、5');
    console.log('3. 每个任务之间间隔 30 秒');
    console.log('4. 观察任务列表是否随进度更新');
  };
}

export { VERIFICATION_TASKS };
