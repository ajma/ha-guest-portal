import type { CatalogEntry } from '@shared/api.js'
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react'

interface EntityPickerProps {
  entities: CatalogEntry[]
  exclude: string[]
  onSelect: (entity: CatalogEntry) => void
}

// Colours, radius and font come from the theme's CSS variables, as with the
// other owner surfaces. This is not a theme component and adds no slot to
// `Theme['components']`.
//
// The literals this replaced were not merely off-palette, they were unreadable:
// the picker opens inside the Add-device panel, which sets `color: var(--text)`,
// so an option row hardcoded to `white` put light-grey device names on white in
// every dark theme.
const searchInput: CSSProperties = {
  padding: '8px',
  fontSize: '14px',
  fontFamily: 'inherit',
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  width: '100%',
}

const listbox: CSSProperties = {
  margin: '4px 0 0 0',
  padding: 0,
  color: 'var(--text)',
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--tileRadius)',
  // Grows into whatever the dialog allows rather than stopping at a fixed
  // height. The ghost tile only opens this; once open it is the whole task, so
  // a short scroll window over a long list is wasted screen.
  flex: '1 1 auto',
  minHeight: 0,
  maxHeight: 'min(60vh, 520px)',
  overflow: 'auto',
}

const optionArea: CSSProperties = { fontSize: '12px', color: 'var(--textMuted)', marginTop: '2px' }

const optionId: CSSProperties = { fontSize: '11px', color: 'var(--textMuted)', marginTop: '2px' }

export function EntityPicker({ entities, exclude, onSelect }: EntityPickerProps): ReactElement {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isOpen, setIsOpen] = useState(false)
  const listboxRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const excludeSet = new Set(exclude)

  // Only entities the portal can actually operate are offered. A row that can
  // be seen but never chosen is noise, and on a real installation it is most of
  // the list: one house here had 2,495 such entities against 353 usable ones.
  const filtered = entities.filter((entity) => {
    if (!entity.supported) return false
    if (excludeSet.has(entity.entityId)) return false

    const lowerQuery = query.toLowerCase()
    const matchesName = entity.name.toLowerCase().includes(lowerQuery)
    const matchesId = entity.entityId.toLowerCase().includes(lowerQuery)

    return matchesName || matchesId
  })

  // Scroll active option into view
  useEffect(() => {
    if (activeIndex >= 0 && listboxRef.current) {
      const activeOption = listboxRef.current.children[activeIndex]
      if (activeOption instanceof HTMLElement) {
        activeOption.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [activeIndex])

  // Click outside to close
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (event: MouseEvent): void => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        setIsOpen(false)
        setActiveIndex(-1)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isOpen || filtered.length === 0) return

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((prev) => {
          if (prev === -1) return 0
          return (prev + 1) % filtered.length
        })
        break

      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((prev) => {
          if (prev === -1) return filtered.length - 1
          return (prev - 1 + filtered.length) % filtered.length
        })
        break

      case 'Enter':
        event.preventDefault()
        if (activeIndex >= 0) {
          const selected = filtered[activeIndex]
          if (selected !== undefined) {
            onSelect(selected)
            setQuery('')
            setIsOpen(false)
            setActiveIndex(-1)
          }
        }
        break

      case 'Escape':
        event.preventDefault()
        setIsOpen(false)
        setActiveIndex(-1)
        break

      case 'Tab':
        setIsOpen(false)
        setActiveIndex(-1)
        break
    }
  }

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.value
    setQuery(value)
    setIsOpen(value.length > 0)
    setActiveIndex(-1)
  }

  const handleOptionClick = (entity: CatalogEntry): void => {
    onSelect(entity)
    setQuery('')
    setIsOpen(false)
    setActiveIndex(-1)
  }

  return (
    <div ref={containerRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls="entity-listbox"
        aria-activedescendant={activeIndex >= 0 ? `entity-option-${activeIndex}` : ''}
        value={query}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        placeholder="Search entities..."
        style={searchInput}
      />
      {isOpen && filtered.length > 0 && (
        <div id="entity-listbox" role="listbox" ref={listboxRef} style={listbox}>
          {filtered.map((entity, index) => (
            <div
              key={entity.entityId}
              id={`entity-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => handleOptionClick(entity)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handleOptionClick(entity)
                }
              }}
              tabIndex={-1}
              style={{
                padding: '8px 12px',
                cursor: 'pointer',
                // --surfaceActive rather than the accent: this marks which row
                // the arrow keys are on, not a selection, and an accent fill
                // would read as "already added".
                backgroundColor: index === activeIndex ? 'var(--surfaceActive)' : 'var(--surface)',
              }}
            >
              <div style={{ fontWeight: 500 }}>{entity.name}</div>
              <div style={optionArea}>{entity.area ?? 'No area'}</div>
              <div style={optionId}>{entity.entityId}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
