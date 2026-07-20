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
  scriptCount: number;
  referenceCount: number;
  assetCount: number;
}

interface SkillFileEntry {
  path: string;
  category: 'script' | 'reference' | 'asset';
  size: number;
  preview: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const CATEGORY_ICONS: Record<SkillFileEntry['category'], string> = {
  script: '>_',
  reference: 'doc',
  asset: 'bin',
};

export function SkillsSection() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [showInstall, setShowInstall] = useState(false);
  // Install form state
  const [installName, setInstallName] = useState('');
  const [installDescription, setInstallDescription] = useState('');
  const [installWhenToUse, setInstallWhenToUse] = useState('');
  const [installContent, setInstallContent] = useState('');
  const [installError, setInstallError] = useState('');
  // Expanded skill name for file viewer panel
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  // File list for expanded skill
  const [skillFiles, setSkillFiles] = useState<SkillFileEntry[]>([]);
  // File viewer modal
  const [viewingFile, setViewingFile] = useState<{ skillName: string; path: string } | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  // Import state
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');

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

  const handleToggleExpand = async (skillName: string) => {
    if (expandedSkill === skillName) {
      setExpandedSkill(null);
      setSkillFiles([]);
      return;
    }
    const files = await window.opsAgent.skills.listFiles(skillName);
    setSkillFiles(files);
    setExpandedSkill(skillName);
  };

  const handleViewFile = async (skillName: string, filePath: string) => {
    setViewingFile({ skillName, path: filePath });
    setFileLoading(true);
    setFileContent('');
    const result = await window.opsAgent.skills.readFile(skillName, filePath);
    if (result.ok && result.content) {
      setFileContent(result.content);
    } else {
      setFileContent(`读取失败: ${result.error ?? '未知错误'}`);
    }
    setFileLoading(false);
  };

  const handleDeleteFile = async (skillName: string, filePath: string) => {
    if (!confirm(`确定删除文件 '${filePath}'？`)) return;
    const result = await window.opsAgent.skills.deleteFile(skillName, filePath);
    if (!result.ok) {
      alert(`删除失败: ${result.error}`);
      return;
    }
    // Refresh file list
    const files = await window.opsAgent.skills.listFiles(skillName);
    setSkillFiles(files);
    loadSkills();
  };

  const handleFolderImport = async () => {
    const dirPath = await window.opsAgent.dialog.openDirectory();
    if (!dirPath) return;

    setImporting(true);
    setImportError('');
    const result = await window.opsAgent.skills.importFromDir(dirPath);
    setImporting(false);

    if (!result.ok) {
      setImportError(result.error ?? '导入失败');
      return;
    }
    if (result.name) {
      alert(`技能 '${result.name}' 导入成功`);
    }
    loadSkills();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">技能管理 (Skills)</h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleFolderImport} disabled={importing}>
            {importing ? '导入中...' : '文件夹导入'}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowInstall(!showInstall)}>
            + 安装技能
          </Button>
        </div>
      </div>
      <p className="text-xs text-zinc-500">
        技能是可复用的诊断流程包。启用后仅元数据注入系统提示（渐进式披露），使用
        <code className="mx-1 rounded bg-zinc-800 px-1 text-zinc-300">/技能名</code>
        调用完整内容。也可在对话中说"帮我安装某个skill"让 AI 自动安装。
      </p>
      {importError && <p className="text-xs text-red-400">{importError}</p>}

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

      {skills.map((skill) => {
        const hasFiles = skill.scriptCount + skill.referenceCount + skill.assetCount > 0;
        const isExpanded = expandedSkill === skill.name;
        return (
          <div
            key={skill.name}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5"
          >
            <div className="flex items-center justify-between">
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
                {hasFiles && (
                  <div className="mt-1 flex items-center gap-2 text-xs">
                    {skill.scriptCount > 0 && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-blue-300">
                        {skill.scriptCount} 脚本
                      </span>
                    )}
                    {skill.referenceCount > 0 && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-green-300">
                        {skill.referenceCount} 文档
                      </span>
                    )}
                    {skill.assetCount > 0 && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-amber-300">
                        {skill.assetCount} 资源
                      </span>
                    )}
                  </div>
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
                {skill.source === 'user' && hasFiles && (
                  <button
                    onClick={() => handleToggleExpand(skill.name)}
                    className="rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    {isExpanded ? '收起' : '查看文件'}
                  </button>
                )}
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

            {/* Expanded file list */}
            {isExpanded && skill.source === 'user' && (
              <div className="mt-2 space-y-1 border-t border-zinc-800 pt-2">
                {skillFiles.length === 0 ? (
                  <p className="text-xs text-zinc-600">无文件</p>
                ) : (
                  skillFiles.map((file) => (
                    <div
                      key={file.path}
                      className="group flex items-center gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                    >
                      <span className="w-8 shrink-0 text-center font-mono text-[10px] text-zinc-500">
                        {CATEGORY_ICONS[file.category]}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
                        {file.path}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-600">
                        {formatSize(file.size)}
                      </span>
                      <button
                        onClick={() => handleViewFile(skill.name, file.path)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-blue-400 opacity-0 transition-opacity hover:bg-zinc-700 group-hover:opacity-100"
                      >
                        查看
                      </button>
                      <button
                        onClick={() => handleDeleteFile(skill.name, file.path)}
                        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-red-400 opacity-0 transition-opacity hover:bg-zinc-700 group-hover:opacity-100"
                      >
                        删除
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* File viewer modal */}
      {viewingFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setViewingFile(null)}
        >
          <div
            className="flex max-h-[80vh] w-[700px] max-w-[90vw] flex-col rounded-md border border-zinc-700 bg-zinc-900"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-zinc-700 px-4 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500">{viewingFile.skillName}</span>
                <span className="font-mono text-xs text-zinc-300">{viewingFile.path}</span>
              </div>
              <button
                onClick={() => setViewingFile(null)}
                className="text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {fileLoading ? (
                <p className="text-xs text-zinc-500">加载中...</p>
              ) : (
                <pre className="whitespace-pre-wrap break-all font-mono text-xs text-zinc-200">
                  {fileContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
