import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">页面出错了</h1>
            <p className="text-muted-foreground max-w-md text-sm">
              应用遇到了意外错误。你可以尝试恢复，或刷新页面重新开始。
            </p>
          </div>
          {this.state.error && (
            <pre className="bg-muted max-w-lg overflow-auto rounded-md p-3 text-left text-xs">
              {this.state.error.message}
            </pre>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={this.handleRetry}>
              重试
            </Button>
            <Button onClick={this.handleReload}>刷新页面</Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
