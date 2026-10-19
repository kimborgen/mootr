// Settings › Requirements › Import: what a file must hold before it is sent to the batch route.
import { describe, expect, it } from 'vitest'
import { parseImport } from './ReqImport'

describe('parseImport', () => {
  it('takes a list or {requirements: [...]}', () => {
    expect(parseImport('[{"title":"A"}]')).toEqual({ requirements: [{ title: 'A' }] })
    expect(parseImport('{"requirements":[{"title":"A"},{"title":"B"}]}')).toEqual({ requirements: [{ title: 'A' }, { title: 'B' }] })
  })
  it('says why a file can\'t be imported', () => {
    expect(parseImport('not json')).toEqual({ error: 'The file is not JSON.' })
    expect(parseImport('{"title":"A"}')).toHaveProperty('error')
    expect(parseImport('[]')).toEqual({ error: 'The file holds no requirements.' })
    expect(parseImport('[1, {"title":"A"}]')).toEqual({ error: 'Each requirement must be an object.' })
  })
})
