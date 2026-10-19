import { itsaData, TREE } from '../stories/itsaFixtures'
import { loadReqs, REQ_OFF, REQ_ON } from '../stories/reqFixtures'
import { ds, type Story } from '../stories/types'
import { ItsaReqs } from './ItsaReqs'

const frame = (key: string) => <div className="itsa-view" style={{ minHeight: 40 }}><div className="itsa-inner"><p className="muted">Above the panel:</p><ItsaReqs it={{ id: `fx-i-${key.slice(2)}`, key }} /></div></div>
const data = itsaData(TREE)

export const stories: Story[] = [{
  name: 'ITSA requirements panel',
  group: 'ITSA and work',
  what: 'The Requirements section of an ITSA\'s page: each requirement linked to the ITSA, with its role (allocated to, constrains, informs) and its latest check of the ITSA itself, worded as an indication ("likely conforms", "unsure", "likely violates 91%", "not checked here", or the waiver kind). A row opens the requirement.',
  when: 'In the ITSA view (`w:itsa:ID`), after the Children section, while requirements are on and at least one is linked to the ITSA. Otherwise it draws nothing.',
  code: ['web/src/req/ItsaReqs.tsx#ItsaReqs', 'web/src/req/model.ts#linkedTo'],
  rules: [
    'A row is the Children list\'s row (`.ikid`): at least `--size-row-table` tall, `--size-hit-touch` on a phone, with the requirement state glyph, key, title, role, and verdict word; a requirement not in force is muted.',
    'The verdict word takes the verdict\'s `--rq-*` tone; a waived verdict says its kind in muted text instead. The word, not the colour, carries the meaning (' + ds('State vocabulary') + ').',
    'A requirement with no check on this ITSA says "not checked here" and draws the dashed unverified glyph.',
  ],
  states: [
    { name: 'Three linked requirements', data, routes: REQ_ON, setup: loadReqs, render: () => frame('S-911') },
    { name: 'One, a draft not yet checked', data, routes: REQ_ON, setup: loadReqs, render: () => frame('S-912') },
    { name: 'None linked, so nothing shows', data, routes: REQ_ON, setup: loadReqs, render: () => frame('S-916') },
    { name: 'Requirements off, so nothing shows', data, routes: REQ_OFF, setup: loadReqs, render: () => frame('S-911') },
  ],
}]
