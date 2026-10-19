// One view that throws while rendering shows this in its own pane, and the rest of the app
// keeps working (S-2084: one bad mail block in an ITSA took the whole app down).
import { Component, type ReactNode } from 'react'

export class ViewBoundary extends Component<{ viewKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error('view', this.props.viewKey, error) }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="empty-pane" role="alert" data-view-error={this.props.viewKey}>
        <h3>Couldn't show this view</h3>
        <p>{error.message || String(error)}</p>
        <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    )
  }
}
