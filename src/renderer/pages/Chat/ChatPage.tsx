import { useEffect, useState, useCallback } from 'react';
import { SessionSidebar } from './SessionSidebar.js';
import { MessageList } from './MessageList.js';
import { MessageInput } from './MessageInput.js';
import { AuthDialog } from '../../components/AuthDialog.js';
import { useSessionStore } from '../../store/sessionStore.js';
import { useAgentStore } from '../../store/agentStore.js';
import { useModelStore } from '../../store/modelStore.js';
import { useHostStore } from '../../store/hostStore.js';
import { Button } from '../../components/Button.js';
import type { Message } from '../../../shared/types.js';

export function ChatPage() {
  const { currentSession, messages, hostIds, safetyMode, createSession, truncateMessagesAfter } =
    useSessionStore();
  const { isRunning, streamingText, toolCards, error, startRun, cancelRun, clearError } =
    useAgentStore();
  const { activeProvider, load: loadModels } = useModelStore();
  const { hosts, load: loadHosts } = useHostStore();
  const [editFromMessage, setEditFromMessage] = useState<Message | null>(null);

  useEffect(() => {
    loadModels();
    loadHosts();
  }, [loadModels, loadHosts]);

  const handleSend = async (text: string) => {
    // Ensure we have a session
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
      alert(`导出失败: ${(err as Error).message}`);
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
        </header>

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
    </div>
  );
}
