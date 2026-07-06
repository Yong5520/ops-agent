import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState } from 'react';
import { cn } from '../lib/cn.js';

// Markdown renderer for AI assistant responses.
// Supports GFM (tables, task lists, strikethrough) and code blocks with
// copy-to-clipboard. Uses react-markdown + remark-gfm.

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn('markdown-body text-sm text-zinc-100', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks — inline vs block
          code({ className: cls, children, ...props }) {
            const match = /language-(\w+)/.exec(cls || '');
            const lang = match ? match[1] : '';
            const text = String(children).replace(/\n$/, '');

            // In react-markdown v9, inline code has no className and no newlines
            const isInline = !cls && !text.includes('\n');

            if (isInline) {
              return (
                <code
                  className="rounded bg-zinc-800 px-1 py-0.5 text-xs text-zinc-300 font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            return <CodeBlock language={lang}>{text}</CodeBlock>;
          },
          // Tables
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="w-full border-collapse text-xs">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-zinc-700 bg-zinc-800 px-2 py-1 text-left font-semibold text-zinc-200">
                {children}
              </th>
            );
          },
          td({ children }) {
            return <td className="border border-zinc-800 px-2 py-1 text-zinc-300">{children}</td>;
          },
          // Links — open in external browser
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                {children}
              </a>
            );
          },
          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote className="my-2 border-l-2 border-zinc-600 pl-3 text-zinc-400 italic">
                {children}
              </blockquote>
            );
          },
          // Lists
          ul({ children }) {
            return <ul className="my-1 list-disc space-y-0.5 pl-5">{children}</ul>;
          },
          ol({ children }) {
            return <ol className="my-1 list-decimal space-y-0.5 pl-5">{children}</ol>;
          },
          // Headings
          h1({ children }) {
            return <h1 className="mb-2 mt-3 text-base font-bold text-zinc-100">{children}</h1>;
          },
          h2({ children }) {
            return <h2 className="mb-2 mt-3 text-sm font-bold text-zinc-100">{children}</h2>;
          },
          h3({ children }) {
            return <h3 className="mb-1 mt-2 text-sm font-semibold text-zinc-200">{children}</h3>;
          },
          // Paragraphs
          p({ children }) {
            return <p className="my-1 leading-relaxed">{children}</p>;
          },
          // Horizontal rule
          hr() {
            return <hr className="my-3 border-zinc-800" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Code block with copy button and language label.
function CodeBlock({ language, children }: { language: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1">
        <span className="text-xs text-zinc-500 font-mono">{language || 'text'}</span>
        <button
          onClick={handleCopy}
          className="text-xs text-zinc-500 opacity-0 transition-opacity hover:text-zinc-300 group-hover:opacity-100"
        >
          {copied ? '✓ 已复制' : '复制'}
        </button>
      </div>
      {/* Code content */}
      <pre className="overflow-x-auto p-3 text-xs text-zinc-300 font-mono">
        <code>{children}</code>
      </pre>
    </div>
  );
}
