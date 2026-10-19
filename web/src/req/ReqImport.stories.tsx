import { OnMount } from '../stories/helpers'
import { pickFile, REQ_ON } from '../stories/reqFixtures'
import { ds, reply, type Story } from '../stories/types'
import { ReqImport } from './ReqImport'

const imp = (enabled = true) => <div className="story-pad"><ReqImport enabled={enabled} /></div>
const FILE = JSON.stringify({ requirements: [{ title: 'Retries back off' }, { title: 'Retries stop' }] })
const OK = { 'POST /api/requirements/batch': { requirements: [{ key: 'R-8' }, { key: 'R-9' }], approval: { itsa: 'S-950' } }, ...REQ_ON }

export const stories: Story[] = [{
  name: 'Requirements import',
  group: 'ITSA and work',
  what: 'A button that imports a JSON file of requirements, either a list or `{"requirements": [...]}`. The daemon creates them parents first; a batch from an agent raises one approval ask. The result, or the reason the file was refused, shows beside the button.',
  when: 'In Settings › Requirements, in the row labelled Import. The button is disabled, with the reason in its title, until requirements are on.',
  code: ['web/src/req/ReqImport.tsx#ReqImport', 'web/src/req/ReqImport.tsx#parseImport'],
  rules: [
    'A file that is not JSON, holds neither shape, holds no requirements, or holds a non-object is refused before anything is sent, with a sentence saying which, in the error tone with `role="alert"` (' + ds('Empty, loading, and error') + ').',
    'While the request is out the button reads "Importing…" and is disabled. A success says how many were made, names up to five keys, and names the approval ITSA when one was asked; it is polite text, not a toast.',
    'The file input is hidden and the button opens it, so the button is the only control; it has the upload icon and is a standard `.btn`.',
  ],
  states: [
    { name: 'Ready', render: () => imp() },
    { name: 'Requirements off', render: () => imp(false) },
    { name: 'Imported', routes: OK, render: () => <OnMount run={pickFile(FILE)}>{imp()}</OnMount> },
    { name: 'Not JSON', routes: OK, render: () => <OnMount run={pickFile('this is not json')}>{imp()}</OnMount> },
    { name: 'Refused by the daemon', routes: { 'POST /api/requirements/batch': reply(422, { error: 'fixture: R-8 names a parent that does not exist' }), ...REQ_ON }, render: () => <OnMount run={pickFile(FILE)}>{imp()}</OnMount> },
  ],
}]
