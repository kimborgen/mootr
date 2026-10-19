import type { ReactNode } from 'react'
import type { DiffFileItem } from './diffModel'

// The top row of a file's section in the diff view (S-2103): the path (old → new for a rename), its status, its +/−
// counts, and its actions — whatever the file has of its own, then Hide and Viewed. Shared by a PR's file (FileDiff)
// and a pasted patch's (PatchDiff), so both sources reuse one shell. A protected path hides its counts and its actions.
export interface DiffFileHeadProps {
  file: DiffFileItem
  viewed: boolean
  onViewed: (on: boolean) => void
  onHide: () => void
  // The file's own actions, before Hide and Viewed (a PR's file adds "Expand all" once its text is shown).
  children?: ReactNode
}

export function DiffFileHead({ file, viewed, onViewed, onHide, children }: DiffFileHeadProps) {
  return (
    <header className="dv-file-head">
      <span className="dv-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
        {file.oldPath && <><span className="dv-old">{file.oldPath}</span><span className="dv-arrow" aria-hidden> → </span></>}{file.path}
      </span>
      <span className="dv-status muted">{file.status === 'modified' ? '' : file.status}</span>
      {!file.denied && <span className="dv-counts"><span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span></span>}
      <span className="dv-file-actions">
        {children}
        {!file.denied && <button type="button" className="dv-btn" onClick={onHide}>Hide</button>}
        {!file.denied && (
          <label className="dv-viewed">
            <input type="checkbox" checked={viewed} onChange={(e) => onViewed(e.target.checked)} /> Viewed
          </label>
        )}
      </span>
    </header>
  )
}
