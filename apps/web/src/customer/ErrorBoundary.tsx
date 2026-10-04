import { Component, type ReactNode } from 'react';

export class CustomerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('customer area error', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="cx-page"><div className="cx-card cx-center" role="alert">
        <h1 className="cx-h1">Something went wrong</h1>
        <p className="cx-muted">Please reload the page. Your uploaded file is kept until it expires.</p>
        <button className="cx-btn cx-btn-primary" onClick={() => window.location.reload()}>Reload</button>
      </div></main>
    );
  }
}
