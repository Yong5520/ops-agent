import { useEffect, useState, useCallback } from 'react';
import { SessionSidebar } from './SessionSidebar.js';
import { MessageList } from './MessageList.js';
import { MessageInput } from './MessageInput.js';
import { AuthDialog } from '../../components/AuthDialog.js';
import { TaskList } from '../../components/TaskList.js';
import { PlanApprovalDialog } from '../../components/PlanApprovalDialog.js';
import { parseSlashCommand } from './slash-commands.js';
import { parseQuickCommand } from '../../../shared/quick-command.js';
import { useSessionStore } from '../../store/sessionStore.js';
import { useAgentStore } from '../../store/agentStore.js';
import { useModelStore } from '../../store/modelStore.js';
import { useHostStore } from '../../store/hostStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { Button } from '../../components/Button.js';
import type { Message } from '../../../shared/types.js';

interface PendingPlanApproval {
  sessionId: string;
  plan: string;
}

export function ChatPage() {
  const {
    currentSession,
    messages,
    hostIds,
    safetyMode,
    todos,
    createSession,
    truncateMessagesAfter,
  } = useSessionStore();
  const {
    isRunning,
    streamingText,
    toolCards,
    error,
    contextUsage,
    startRun,
    cancelRun,
    clearError,
  } = useAgentStore();
  const { activeProvider, load: loadModels } = useModelStore();
  const { hosts, load: loadHosts } = useHostStore();
  const [editFromMessage, setEditFromMessage] = useState<Message | null>(null);
  const [pendingPlanApproval, setPendingPlanApproval] = useState<PendingPlanApproval | null>(null);

  // Subscribe to plan approval requests from the agent (P0-1.B)
  useEffect(() => {
    const unsubscribe = window.opsAgent.agent.onPlanApprovalRequest((event) => {
      setPendingPlanApproval({ sessionId: event.sessionId, plan: event.plan });
    });
    return unsubscribe;
  }, []);

  // Subscribe to mode change events from the agent (P0-1.B fix: state desync)
  // When ExitPlanMode switches mode from 'plan' to 'operator', update the
  // renderer's sessionStore so the NEXT loop starts in the correct mode.
  useEffect(() => {
    const unsubscribe = window.opsAgent.agent.onModeChange((event) => {
      useSessionStore.getState().setSafetyMode(event.mode);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    loadModels();
    loadHosts();
  }, [loadModels, loadHosts]);

  const handleSend = async (text: string) => {
    // Check for quick commands (> or $ prefix) - directly execute via SSH
    // without going through the AI agent loop.
    const quickCmd = parseQuickCommand(text);
    if (quickCmd.isQuickCommand) {
      let session = currentSession;
      if (!session) {
        const latestHostIds = useSessionStore.getState().hostIds;
        session = await createSession({ hostIds: latestHostIds, safetyMode });
      }
      await handleQuickCommand(session.id, text, quickCmd.command!, quickCmd.hostName);
      return;
    }

    // Check for slash commands (/compact, /context, /skillName)
    const parsed = parseSlashCommand(text);
    if (parsed.command !== 'none') {
      // Ensure we have a session for slash commands too
      let session = currentSession;
      if (!session) {
        const latestHostIds = useSessionStore.getState().hostIds;
        session = await createSession({ hostIds: latestHostIds, safetyMode });
      }

      if (parsed.command === 'compact') {
        await handleCompact(session.id, parsed.instructions);
        return;
      }
      if (parsed.command === 'context') {
        await handleContext(session.id);
        return;
      }
      if (parsed.command === 'skill') {
        await handleSkillInvocation(session.id, parsed.name!, parsed.args ?? '', text);
        return;
      }
    }

    // Normal message flow
    let session = currentSession;
    if (!session) {
      // Read latest hostIds from the store to capture any hosts added via @mention
      const latestHostIds = useSessionStore.getState().hostIds;
      session = await createSession({ hostIds: latestHostIds, safetyMode });
    }

    // Add user message to UI immediately
    useSessionStore.getState().addMessage({
      id: `tmp-user-${Date.now()}`,
      sessionId: session.id,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    });

    // Start the agent loop with the latest hostIds
    const latestHostIds = useSessionStore.getState().hostIds;
    await startRun({
      sessionId: session.id,
      userMessage: text,
      hostIds: latestHostIds,
      safetyMode,
    });
  };

  // Handle /compact command - manually trigger context compression
  const handleCompact = async (sessionId: string, instructions?: string) => {
    // Show the user's command as a user message
    useSessionStore.getState().addMessage({
      id: `tmp-user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: instructions ? `/compact ${instructions}` : '/compact',
      createdAt: new Date().toISOString(),
    });

    try {
      const result = await window.opsAgent.agent.compact(sessionId, instructions);
      let content: string;
      if (!result.ok) {
        if (result.reason === 'too_few_messages') {
          content = `⚠ 对话太短（${result.messageCount} 条消息），无需压缩。建议在对话超过 5 条消息后再使用 /compact。`;
        } else if (result.reason === 'no_model') {
          content = '⚠ 未配置模型，无法执行上下文压缩。请先在设置页配置模型。';
        } else {
          content = '⚠ 上下文压缩失败。';
        }
      } else {
        content = `✓ 上下文已压缩（${result.messageCount} 条消息 -> ${result.compressedCount} 条消息）`;
        if (result.summary) {
          content += `\n\n${result.summary}`;
        }
      }
      useSessionStore.getState().addMessage({
        id: `msg-system-${Date.now()}`,
        sessionId,
        role: 'system',
        content,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId,
        role: 'system',
        content: `[错误] 压缩失败: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      });
    }
  };

  // Handle /context command - show context usage breakdown
  const handleContext = async (sessionId: string) => {
    // Show the user's command as a user message
    useSessionStore.getState().addMessage({
      id: `tmp-user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: '/context',
      createdAt: new Date().toISOString(),
    });

    try {
      const data = await window.opsAgent.agent.getContext(sessionId);
      const formatTokens = (n: number) => {
        if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
        return String(n);
      };

      let content = `## 上下文使用分析\n\n`;
      content += `模型: ${data.model} | 上下文窗口: ${formatTokens(data.contextWindow)} tokens | 已用: ${formatTokens(data.totalUsed)} (${data.percentage}%)\n\n`;
      content += `| 类别 | Tokens | 占比 |\n|------|--------|------|\n`;
      for (const cat of data.categories) {
        content += `| ${cat.name} | ${formatTokens(cat.tokens)} | ${cat.percentage}% |\n`;
      }

      content += `\n### 系统提示详情\n`;
      for (const sec of data.systemPromptSections) {
        content += `- ${sec.name}: ~${formatTokens(sec.tokens)} tokens\n`;
      }

      content += `\n### 工具列表\n`;
      for (const tool of data.tools) {
        content += `- ${tool.name}: ~${formatTokens(tool.tokens)} tokens\n`;
      }

      content += `\n### 技能列表 (渐进式披露: 仅元数据加载)\n`;
      for (const skill of data.skills) {
        const status = skill.enabled ? '已启用' : '已禁用';
        content += `- ${skill.name}: ~${formatTokens(skill.tokens)} tokens (${status})\n`;
      }

      content += `\n### 消息详情\n`;
      content += `- 用户消息: ${formatTokens(data.messageBreakdown.totalTokens)} tokens (${data.messageBreakdown.userMessages} 条)\n`;
      content += `- 助手消息: (${data.messageBreakdown.assistantMessages} 条)\n`;
      if (data.messageBreakdown.systemMessages > 0) {
        content += `- 系统消息: (${data.messageBreakdown.systemMessages} 条)\n`;
      }

      useSessionStore.getState().addMessage({
        id: `msg-system-${Date.now()}`,
        sessionId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId,
        role: 'system',
        content: `[错误] 获取上下文信息失败: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      });
    }
  };

  // Handle /skillName invocation - inject skill content into the message
  const handleSkillInvocation = async (
    sessionId: string,
    skillName: string,
    args: string,
    originalText: string,
  ) => {
    try {
      // Fetch the skill's full content from the backend
      const skillContent = await window.opsAgent.skills.getContent(skillName);
      if (!skillContent) {
        useSessionStore.getState().addMessage({
          id: `tmp-user-${Date.now()}`,
          sessionId,
          role: 'user',
          content: originalText,
          createdAt: new Date().toISOString(),
        });
        useSessionStore.getState().addMessage({
          id: `msg-error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `未找到技能 '${skillName}'。请检查名称或在设置页安装。`,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      // Build enhanced message with skill content + user request
      const enhancedMessage = `[技能指南: ${skillName}]\n\n${skillContent}\n\n---\n用户请求: ${args || '(无附加说明)'}`;

      // Show the original /skillName command as user message
      useSessionStore.getState().addMessage({
        id: `tmp-user-${Date.now()}`,
        sessionId,
        role: 'user',
        content: originalText,
        createdAt: new Date().toISOString(),
      });

      // Start the agent loop with the enhanced message (skill content injected)
      const latestHostIds = useSessionStore.getState().hostIds;
      await startRun({
        sessionId,
        userMessage: enhancedMessage,
        hostIds: latestHostIds,
        safetyMode,
      });
    } catch (err) {
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId,
        role: 'system',
        content: `[错误] 加载技能失败: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      });
    }
  };

  // Handle quick command (> or $ prefix) - directly execute via SSH
  const handleQuickCommand = async (
    sessionId: string,
    originalText: string,
    command: string,
    hostName?: string,
  ) => {
    // Show the user's command as a user message
    useSessionStore.getState().addMessage({
      id: `tmp-user-${Date.now()}`,
      sessionId,
      role: 'user',
      content: originalText,
      createdAt: new Date().toISOString(),
    });

    // Show "executing" system message
    const execMsgId = `msg-exec-${Date.now()}`;
    useSessionStore.getState().addMessage({
      id: execMsgId,
      sessionId,
      role: 'system',
      content: `⏳ 正在 ${hostName ? hostName : '默认主机'} 上执行: \`${command}\``,
      createdAt: new Date().toISOString(),
    });

    try {
      const result = await window.opsAgent.agent.quickCommand(sessionId, command, hostName);
      if (!result.ok) {
        useSessionStore.getState().addMessage({
          id: `msg-error-${Date.now()}`,
          sessionId,
          role: 'system',
          content: `❌ 执行失败: ${result.error}`,
          createdAt: new Date().toISOString(),
        });
        return;
      }

      // Build output message
      let output = `\`\`\`exit=${result.exitCode} | ${result.hostName}\n`;
      if (result.stdout) output += result.stdout;
      if (result.stderr) output += `\n[stderr]\n${result.stderr}`;
      output += '\n```';

      useSessionStore.getState().addMessage({
        id: `msg-result-${Date.now()}`,
        sessionId,
        role: 'system',
        content: output,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      useSessionStore.getState().addMessage({
        id: `msg-error-${Date.now()}`,
        sessionId,
        role: 'system',
        content: `❌ 执行异常: ${(err as Error).message}`,
        createdAt: new Date().toISOString(),
      });
    }
  };

  const handleEdit = useCallback(
    async (message: Message) => {
      // Truncate the edited message and everything after it from the DB + local
      // array. After this, the textarea will be prefilled with the original
      // content and the user can tweak + re-send.
      await truncateMessagesAfter(message.id);
      setEditFromMessage({ ...message });
    },
    [truncateMessagesAfter],
  );

  const handleMentionHost = useCallback((hostId: string) => {
    const { hostIds: current } = useSessionStore.getState();
    if (!current.includes(hostId)) {
      useSessionStore.getState().setHostIds([...current, hostId]);
    }
  }, []);

  const handleExport = async () => {
    if (!currentSession) return;
    try {
      const result = await window.opsAgent.sessions.export(currentSession.id);
      // Trigger download via Blob
      const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      useAgentStore.getState().clearError();
      await useUiStore.getState().confirm({
        title: '导出失败',
        message: (err as Error).message,
        confirmLabel: '确定',
        cancelLabel: '关闭',
      });
    }
  };

  // No session selected - show empty state with input
  if (!currentSession && !isRunning) {
    return (
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <SessionSidebar />
        <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
          <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
            <div>
              <h1 className="text-lg font-semibold">对话</h1>
              <p className="text-xs text-zinc-500">
                {activeProvider ? `模型: ${activeProvider.name}` : '未配置模型'}
                {' · '}
                {hosts.length > 0 ? `${hosts.length} 台主机` : '未配置主机'}
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => createSession({ hostIds, safetyMode })}
            >
              + 新建会话
            </Button>
          </header>

          <div className="flex flex-1 flex-col items-center justify-center">
            {!activeProvider ? (
              <div className="text-center">
                <p className="text-sm text-zinc-400">请先配置模型供应商</p>
                <a
                  href="#/settings"
                  className="mt-2 inline-block text-sm text-blue-400 hover:underline"
                >
                  前往设置 -&gt;
                </a>
              </div>
            ) : hosts.length === 0 ? (
              <div className="text-center">
                <p className="text-sm text-zinc-400">请先配置目标主机</p>
                <a
                  href="#/settings"
                  className="mt-2 inline-block text-sm text-blue-400 hover:underline"
                >
                  前往设置 -&gt;
                </a>
              </div>
            ) : (
              <div className="text-center">
                <div className="text-4xl mb-3">🤖</div>
                <p className="text-sm text-zinc-400">输入运维需求开始，或点击左侧"新建会话"</p>
              </div>
            )}
          </div>

          {/* Input - always available so user can type and @mention hosts even without a session */}
          <MessageInput
            isRunning={isRunning}
            onSend={handleSend}
            onCancel={() => {}}
            onMentionHost={handleMentionHost}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <SessionSidebar />

      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {/* Header */}
        <header className="flex items-center justify-between border-b border-zinc-800 px-6 py-3">
          <div>
            <h1 className="text-lg font-semibold">
              {currentSession?.title ?? `会话 ${currentSession?.id.slice(0, 8)}`}
            </h1>
            <p className="text-xs text-zinc-500">
              {activeProvider?.name ?? '未配置模型'} · {safetyMode} 模式 · {hostIds.length} 台主机
            </p>
          </div>
          <div className="flex items-center gap-3">
            {contextUsage &&
              contextUsage.totalTokens > 0 &&
              (() => {
                const formatK = (n: number) =>
                  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
                return (
                  <span
                    className={`text-xs font-mono ${
                      contextUsage.percentage >= 85
                        ? 'text-red-400'
                        : contextUsage.percentage >= 60
                          ? 'text-yellow-400'
                          : 'text-zinc-500'
                    }`}
                    title={`已用 ${contextUsage.usedTokens.toLocaleString()} / ${contextUsage.totalTokens.toLocaleString()} tokens`}
                  >
                    上下文 {formatK(contextUsage.usedTokens)}/{formatK(contextUsage.totalTokens)} (
                    {contextUsage.percentage}%)
                  </span>
                );
              })()}
            {error && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-400">{error}</span>
                <Button size="sm" variant="ghost" onClick={clearError}>
                  关闭
                </Button>
              </div>
            )}
            {currentSession && (
              <Button size="sm" variant="ghost" onClick={handleExport}>
                导出
              </Button>
            )}
          </div>
        </header>

        {/* Task List (TodoWrite) */}
        <TaskList
          todos={todos}
          onClear={() => {
            if (currentSession) {
              window.opsAgent.tasks.update(currentSession.id, []);
            }
            useSessionStore.getState().setTodos([]);
          }}
        />

        {/* Messages */}
        <MessageList
          messages={messages}
          streamingText={streamingText}
          toolCards={toolCards}
          isRunning={isRunning}
          onEditMessage={handleEdit}
        />

        {/* Input */}
        <MessageInput
          isRunning={isRunning}
          onSend={handleSend}
          onCancel={() => currentSession && cancelRun(currentSession.id)}
          editFromMessage={editFromMessage}
          onClearEdit={() => setEditFromMessage(null)}
          onMentionHost={handleMentionHost}
        />
      </div>

      {/* Authorization dialog (modal) */}
      <AuthDialog />

      {/* Plan approval dialog (P0-1.B) */}
      {pendingPlanApproval && (
        <PlanApprovalDialog
          plan={pendingPlanApproval.plan}
          sessionId={pendingPlanApproval.sessionId}
          onApprove={(editedPlan) => {
            window.opsAgent.agent.respondPlanApproval({
              sessionId: pendingPlanApproval.sessionId,
              approved: true,
              editedPlan,
            });
            setPendingPlanApproval(null);
          }}
          onReject={(reason) => {
            window.opsAgent.agent.respondPlanApproval({
              sessionId: pendingPlanApproval.sessionId,
              approved: false,
              reason,
            });
            setPendingPlanApproval(null);
          }}
        />
      )}
    </div>
  );
}
