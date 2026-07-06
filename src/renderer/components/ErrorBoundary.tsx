import { Component, type ErrorInfo, type ReactNode } from 'react';

// Error boundary — catches render errors in child components and shows
// a fallback UI instead of crashing the entire app to a gray screen.

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-zinc-950 text-zinc-100">
          <div className="max-w-md space-y-3 text-center">
            <div className="text-4xl">⚠</div>
            <h1 className="text-lg font-semibold">页面渲染出错</h1>
            <p className="text-sm text-zinc-400">
              {this.state.error?.message ?? '未知错误'}
            </p>
            <pre className="max-h-40 overflow-auto rounded-md bg-zinc-900 p-3 text-left text-xs text-zinc-500">
              {this.state.error?.stack}
            </pre>
            <button
              onClick={this.handleReset}
              className="rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white"
            >
              重试
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
