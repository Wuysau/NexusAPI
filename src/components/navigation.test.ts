import { describe, expect, it } from 'vitest'
import { DOCS_ENTRY, NAV, searchNavigation } from './navigation'

describe('console navigation search', () => {
  const allowAll = () => true

  it('finds newly added resource and routing pages by label or keyword', () => {
    expect(searchNavigation('资源', allowAll).map((entry) => entry.href)).toContain('/resources')
    expect(searchNavigation('routing', allowAll).map((entry) => entry.href)).toContain('/routing')
  })

  it('includes every sidebar page and documentation in the unfiltered results', () => {
    expect(searchNavigation('', allowAll).map((entry) => entry.href)).toEqual(
      [...NAV, DOCS_ENTRY].map((entry) => entry.href),
    )
  })

  it('does not expose pages without the required capability', () => {
    expect(searchNavigation('资源', () => false)).toEqual([])
  })
})
