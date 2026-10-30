// Settings › Sidebar (S-1422): which panes the desktop sidebar has, which tabs each holds, their
// order, each pane's default tab and the tab strip height. Every edit is a pure function of
// sidebar-panes.ts and applies live through the same save as picking a tab in the sidebar. The
// phone shows the section but doesn't use the panes.
import { Icon } from '../Icon'
import { TABS } from '../SidebarPanes'
import {
  activate, addPane, MAX_PANES, moveSidebarPane, moveTab, removePane, removeTab, revertToMootrDefault, revertToUserDefault, saveUserDefault, sendTab, setSidebarPanes, setTabBar,
  TAB_BARS, unusedTabs, useHasUserDefault, useSidebarPanes, type TabBar,
} from '../sidebar-panes'

const KNOWN = Object.keys(TABS)
const BAR_LABEL: Record<TabBar, string> = { compact: 'Compact', regular: 'Regular' }
const label = (id: string) => TABS[id]?.label ?? id

export function SidebarSettings() {
  const { panes, tabBar } = useSidebarPanes(KNOWN)
  const hasDefault = useHasUserDefault()
  const unused = unusedTabs(panes, KNOWN)
  const total = panes.reduce((n, p) => n + p.tabs.length, 0)
  return (
    <div className="sidebar-set">
      <p className="lede">The panes of the desktop sidebar, top to bottom. Changes apply at once. The phone shows one section at a time and ignores these settings.</p>
      <div className="set-row">
        <div className="set-label"><b>Tab bar height</b><p>Compact is half the height of the main tab bar; regular is the same height.</p></div>
        <div className="set-ctl"><div className="seg" role="radiogroup" aria-label="Tab bar height">{TAB_BARS.map((b) =>
          <button key={b} type="button" role="radio" aria-checked={tabBar === b} className={tabBar === b ? 'on' : ''} onClick={() => setTabBar(b)}>{BAR_LABEL[b]}</button>)}</div></div>
      </div>
      <div className="set-card">
        {panes.map((p, i) => (
          <section key={i} className="sbs-pane" aria-label={`Pane ${i + 1}`} data-pane={i}>
            <div className="sbs-head">
              <b>Pane {i + 1}</b>
              <span className="wcol-ctl">
                <button type="button" className="icon-btn" aria-label={`Move pane ${i + 1} up`} disabled={i === 0} onClick={() => moveSidebarPane(i, -1)}><Icon name="arrow-up" size="xs" /></button>
                <button type="button" className="icon-btn" aria-label={`Move pane ${i + 1} down`} disabled={i === panes.length - 1} onClick={() => moveSidebarPane(i, 1)}><Icon name="arrow-down" size="xs" /></button>
                <button type="button" className="icon-btn" aria-label={`Remove pane ${i + 1}`} disabled={panes.length < 2} onClick={() => setSidebarPanes(removePane(panes, i))}><Icon name="trash-2" size="xs" /></button>
              </span>
            </div>
            <ul className="sbs-tabs">
              {p.tabs.map((id, k) => (
                <li key={id} className="sbs-tab" data-tab={id}>
                  <label className="check" title="Shown when the sidebar opens">
                    <input type="radio" name={`sbs-active-${i}`} checked={p.active === id} onChange={() => setSidebarPanes(activate(panes, i, id))} aria-label={`${label(id)} is the default tab of pane ${i + 1}`} />
                    <Icon name={TABS[id].icon} size="xs" />{label(id)}
                  </label>
                  <span className="wcol-ctl">
                    <button type="button" className="icon-btn" aria-label={`Move ${label(id)} up`} disabled={k === 0} onClick={() => setSidebarPanes(moveTab(panes, id, -1))}><Icon name="arrow-up" size="xs" /></button>
                    <button type="button" className="icon-btn" aria-label={`Move ${label(id)} down`} disabled={k === p.tabs.length - 1} onClick={() => setSidebarPanes(moveTab(panes, id, 1))}><Icon name="arrow-down" size="xs" /></button>
                    <select aria-label={`Move ${label(id)} to`} value="" onChange={(e) => {
                      const v = e.target.value
                      setSidebarPanes(v === 'new' ? addPane(panes, id) : sendTab(panes, id, Number(v)))
                    }}>
                      <option value="">Move to…</option>
                      {panes.map((_, j) => j === i ? null : <option key={j} value={j}>Pane {j + 1}</option>)}
                      {panes.length < MAX_PANES && p.tabs.length > 1 ? <option value="new">New pane</option> : null}
                    </select>
                    <button type="button" className="icon-btn" aria-label={`Remove ${label(id)} from the sidebar`} disabled={total < 2} onClick={() => setSidebarPanes(removeTab(panes, id))}><Icon name="x" size="xs" /></button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="sbs-unused" aria-label="Unused tabs">
        <b>Unused tabs</b>
        {unused.length ? <ul className="sbs-tabs">{unused.map((id) => (
          <li key={id} className="sbs-tab" data-unused={id}>
            <span className="check"><Icon name={TABS[id].icon} size="xs" />{label(id)}</span>
            <select aria-label={`Add ${label(id)} to`} value="" onChange={(e) => {
              const v = e.target.value
              setSidebarPanes(v === 'new' ? addPane(panes, id) : sendTab(panes, id, Number(v)))
            }}>
              <option value="">Add to…</option>
              {panes.map((_, j) => <option key={j} value={j}>Pane {j + 1}</option>)}
              {panes.length < MAX_PANES ? <option value="new">New pane</option> : null}
            </select>
          </li>))}</ul> : <p className="muted">Every tab is in a pane.</p>}
      </div>
      <div className="sbs-foot">
        <p className="muted">The layout above is your current one. Save it as your default, and revert to it, or to mootr's, whenever you like. Reverting changes only the sidebar.</p>
        <div className="sbs-defaults">
          <button type="button" className="btn" id="sidebar-save-default" onClick={saveUserDefault}><Icon name="check" />Save current as my default</button>
          <button type="button" className="btn" id="sidebar-revert-user" disabled={!hasDefault} title={hasDefault ? undefined : 'No default saved yet'} onClick={() => { revertToUserDefault() }}><Icon name="rotate-ccw" />Revert to my default</button>
          <button type="button" className="btn" id="sidebar-reset" onClick={revertToMootrDefault}><Icon name="rotate-ccw" />Revert to mootr's default</button>
        </div>
      </div>
    </div>
  )
}
