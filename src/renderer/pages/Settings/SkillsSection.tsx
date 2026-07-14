import { useEffect, useState } from 'react';
import { Button } from '../../components/Button.js';
import { Input, Textarea, Field } from '../../components/Form.js';

interface SkillItem {
  name: string;
  displayName: string;
  description: string;
  whenToUse?: string;
  source: 'builtin' | 'user';
  enabled: boolean;
  enabledByDefault: boolean;
  filePath?: string;
}

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [showInstall, setShowInstall] = useState(false);
  // Install form state
  const [installName, setInstallName] = useState('');
  const [installDescription, setInstallDescription] = useState('');
  const [installWhenToUse, setInstallWhenToUse] = useState('');
  const [installContent, setInstallContent] = useState('');
  const [installError, setInstallError] = useState('');

  useEffect(() => {
    loadSkills();
  }, []);

  const loadSkills = async () => {
    const result = await window.opsAgent.skills.list();
    setSkills(result);
  };

  const handleToggle = async (skill: SkillItem) => {
    await window.opsAgent.skills.toggle(skill.name, !skill.enabled);
    loadSkills();
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`确定删除技能 '${name}'？`)) return;
    const result = await window.opsAgent.skills.remove(name);
    if (!result.ok) {
      alert(`删除失败: ${result.error}`);
    }
    loadSkills();
  };

  const handleInstall = async () => {
    if (!installName.trim() || !installContent.trim()) {
      setInstallError('名称和内容不能为空');
      return;
    }
    const result = await window.opsAgent.skills.install(
      installName.trim(),
      installContent.trim(),
      installDescription.trim() || undefined,
      installWhenToUse.trim() || undefined,
    );
    if (!result.ok) {
      setInstallError(result.error ?? '安装失败');
      return;
    }
    // Reset form
    setInstallName('');
    setInstallDescription('');
    setInstallWhenToUse('');
    setInstallContent('');
    setInstallError('');
    setShowInstall(false);
    loadSkills();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">技能管理 (Skills)</h2>
        <Button variant="primary" size="sm" onClick={() => setShowInstall(!showInstall)}>
          + 安装技能
        </Button>
      </div>
      <p className="text-xs text-zinc-500">
        技能是可复用的诊断流程包。启用后仅元数据注入系统提示（渐进式披露），使用
        <code className="mx-1 rounded bg-zinc-800 px-1 text-zinc-300">/技能名</code>
        调用完整内容。也可在对话中说"帮我安装某个skill"让 AI 自动安装。
      </p>

      {/* Install form */}
      {showInstall && (
        <div className="space-y-3 rounded-md border border-zinc-700 bg-zinc-900 p-4">
          <h3 className="text-sm font-semibold text-zinc-200">安装新技能</h3>
          <Field label="技能名称 (kebab-case)">
            <Input
              value={installName}
              onChange={(e) => setInstallName(e.target.value)}
              placeholder="例如: redis-diagnosis"
              className="w-full"
            />
          </Field>
          <Field label="简短描述">
            <Input
              value={installDescription}
              onChange={(e) => setInstallDescription(e.target.value)}
              placeholder="例如: Redis 缓存诊断流程"
              className="w-full"
            />
          </Field>
          <Field label="使用场景 (可选)">
            <Input
              value={installWhenToUse}
              onChange={(e) => setInstallWhenToUse(e.target.value)}
              placeholder="例如: 当用户报告 Redis 相关问题时"
              className="w-full"
            />
          </Field>
          <Field label="技能内容 (Markdown)">
            <Textarea
              value={installContent}
              onChange={(e) => setInstallContent(e.target.value)}
              placeholder={
                '## 技能：XXX\n\n当用户报告...时：\n\n1. **步骤1**：`命令`\n2. **步骤2**：`命令`'
              }
              rows={8}
              className="w-full font-mono text-xs"
            />
          </Field>
          {installError && <p className="text-xs text-red-400">{installError}</p>}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={handleInstall}>
              安装
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowInstall(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {/* Skills list */}
      {skills.length === 0 && !showInstall && (
        <p className="rounded-md border border-dashed border-zinc-800 px-4 py-6 text-center text-sm text-zinc-600">
          尚无技能。
        </p>
      )}

      {skills.map((skill) => (
        <div
          key={skill.name}
          className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-200">{skill.displayName}</span>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${
                  skill.source === 'builtin'
                    ? 'bg-blue-900 text-blue-300'
                    : 'bg-green-900 text-green-300'
                }`}
              >
                {skill.source === 'builtin' ? '内置' : '用户'}
              </span>
              <span className="text-xs text-zinc-600">/{skill.name}</span>
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">{skill.description}</p>
            {skill.whenToUse && (
              <p className="mt-0.5 text-xs text-zinc-600">触发: {skill.whenToUse}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleToggle(skill)}
              className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
                skill.enabled ? 'justify-end bg-blue-600' : 'justify-start bg-zinc-700'
              }`}
              title={skill.enabled ? '已启用' : '已禁用'}
            >
              <span className="h-4 w-4 shrink-0 rounded-full bg-white transition-all" />
            </button>
            {skill.source === 'user' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(skill.name)}
                className="text-red-400 hover:text-red-300"
              >
                删除
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
