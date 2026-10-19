// The model picker's list (S-379): cheapest first or by name, filtered by every typed word in
// the id or the name, with prices shown as dollars per million tokens or as unknown.
import { describe, expect, it } from 'vitest'
import { filterModels, priceLabel, sortModels, type CatalogModel } from './ModelPicker'

const models: CatalogModel[] = [
  { id: 'openai/gpt-x', name: 'OpenAI: GPT X', in: 2.5, out: 10 },
  { id: 'google/gemma-3-4b-it', name: 'Google: Gemma 3 4B', in: 0.02, out: 0.04 },
  { id: 'unpriced/model', name: 'Alpha', in: null, out: null },
  { id: 'free/model', name: 'Free model', in: 0, out: 0 },
  { id: 'google/gemma-3-27b-it', name: 'Google: Gemma 3 27B', in: 0.1, out: 0.2 },
]

describe('sortModels', () => {
  it('sorts cheapest first, input then output, with unpriced models last', () => {
    expect(sortModels(models, 'price').map((m) => m.id)).toEqual([
      'free/model', 'google/gemma-3-4b-it', 'google/gemma-3-27b-it', 'openai/gpt-x', 'unpriced/model',
    ])
  })

  it('sorts by name when asked', () => {
    expect(sortModels(models, 'name').map((m) => m.name)).toEqual(['Alpha', 'Free model', 'Google: Gemma 3 27B', 'Google: Gemma 3 4B', 'OpenAI: GPT X'])
  })

  it('does not reorder the list it is given', () => {
    const before = models.map((m) => m.id)
    sortModels(models, 'price')
    expect(models.map((m) => m.id)).toEqual(before)
  })
})

describe('filterModels', () => {
  it('keeps everything for an empty query', () => {
    expect(filterModels(models, '  ')).toBe(models)
  })

  it('matches every typed word against the id or the name, in any case', () => {
    expect(filterModels(models, 'GEMMA 27b').map((m) => m.id)).toEqual(['google/gemma-3-27b-it'])
    expect(filterModels(models, 'google').map((m) => m.id)).toEqual(['google/gemma-3-4b-it', 'google/gemma-3-27b-it'])
    expect(filterModels(models, 'nothing here')).toEqual([])
  })
})

describe('priceLabel', () => {
  it('shows dollars per million tokens, free, or unknown', () => {
    expect(priceLabel(models[0])).toBe('$2.5 in · $10 out')
    expect(priceLabel(models[1])).toBe('$0.02 in · $0.04 out')
    expect(priceLabel(models[3])).toBe('free in · free out')
    expect(priceLabel(models[2])).toBe('price unknown')
  })
})
