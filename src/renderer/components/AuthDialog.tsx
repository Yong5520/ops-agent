import { useAgentStore } from '../store/agentStore.js';
import { Button } from './Button.js';

export function AuthDialog() {
  const { pendingAuths, respondAuth } = useAgentStore();

  if (pendingAuths.length === 0) return null;

  const auth = pendingAuths[0]; // Show one at a time

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
        {/* Header */}
        <div className="border-b border-zinc-800 px-5 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-amber-400">
            <span className="text-lg">⚠</span>
            需要授权
          </h3>
        </div>

        {/* Body */}
        <div className="space-y-3 px-5 py-4">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-zinc-500">主机：</span>
              <span className="text-zinc-200">{auth.hostName}</span>
              <span className="text-zinc-600"> ({auth.hostIp})</span>
            </div>
            <div>
              <span className="text-zinc-500">安全模式：</span>
              <span className="text-zinc-200">{auth.safetyMode}</span>
            </div>
            <div>
              <span className="text-zinc-500">工具：</span>
              <span className="text-zinc-200">{auth.toolName}</span>
            </div>
            <div>
              <span className="text-zinc-500">命令类型：</span>
              <span className="text-zinc-200">{auth.commandType}</span>
            </div>
          </div>

          <div className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2">
            <div className="mb-1 text-xs text-zinc-500">计划执行的命令：</div>
            <code className="block text-sm text-zinc-200 font-mono break-all">{auth.command}</code>
          </div>

          {auth.description && (
            <div className="text-xs text-zinc-400 italic">{auth.description}</div>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <Button variant="danger" onClick={() => respondAuth(auth.toolCallId, false, '用户拒绝')}>
            拒绝
          </Button>
          <Button variant="primary" onClick={() => respondAuth(auth.toolCallId, true)}>
            批准执行
          </Button>
        </div>
      </div>
    </div>
  );
}
