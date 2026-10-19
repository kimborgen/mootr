// The stories page (/stories, docs/stories.md): every visual component with what it is, when
// it shows, its rules, and its states. With ?frame=ID&state=N it draws one state alone, for
// the page's iframes, so each state meets real media queries at its frame's width.
import { createRoot } from 'react-dom/client'
import '../../style.css'
import './stories.css'
import { ImageViewer } from '../ImageViewer'
import { MenuLayer } from '../ui/menu'
import { applyState, installFixtures } from './fixtures'
import { storyById } from './registry'
import { Viewer } from './Viewer'

installFixtures()
const q = new URLSearchParams(location.search)
const root = createRoot(document.getElementById('root')!)
const frame = q.get('frame')

if (frame !== null) {
  document.documentElement.classList.add('story-frame')
  const st = storyById(frame)?.states[Number(q.get('state') ?? 0)]
  if (st) applyState(st)
  root.render(st ? <><main className="story-state">{st.render()}</main><MenuLayer /><ImageViewer /></> : <p className="story-pad muted">No such story state.</p>)
} else {
  document.documentElement.classList.add('stories')
  root.render(<Viewer />)
}
