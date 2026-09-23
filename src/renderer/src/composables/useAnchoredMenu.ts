import { onBeforeUnmount, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'

/**
 * The behaviour every dropdown in this app shares: a list pinned to its control,
 * opened by the control, closed by Escape or a click anywhere else, navigated with
 * the arrow keys.
 *
 * Extracted because the model picker and the plain selects have to feel like the
 * same control — they *are* the same control with different contents — and the
 * placement rules are fiddly enough (see `place`) that a second copy would drift
 * from the first.
 */
export interface AnchoredMenuOptions {
  /** How many rows the list currently has; 0 disables keyboard navigation. */
  count: () => number
  /** Index the list starts on when it opens: the row already in use. */
  selected: () => number
  /** Called with the index to accept, from Enter or a click. */
  onPick: (index: number) => void
  /** Raise the menu's width above the control's, for long labels. */
  minWidth?: () => number
}

export interface AnchoredMenu {
  open: Ref<boolean>
  highlighted: Ref<number>
  menuStyle: Ref<Record<string, string>>
  /**
   * `:ref` handlers for the three elements the menu needs — the wrapper, the
   * control and (inside the teleport) the list.
   *
   * The elements are held here rather than in the component: a component that only
   * ever names them in a `ref="…"` attribute has no use for them itself, and the
   * `menuStyle` it does read is derived from them.
   */
  bindRoot: (el: Element | ComponentPublicInstance | null) => void
  bindAnchor: (el: Element | ComponentPublicInstance | null) => void
  bindMenu: (el: Element | ComponentPublicInstance | null) => void
  toggle: () => void
  close: () => void
  /** Accepts a row: hands it to `onPick`, closes, and puts focus back. */
  choose: (index: number) => void
  /** Puts the highlight on `index`; for controls the user types into. */
  setHighlight: (index: number) => void
  onKeydown: (event: KeyboardEvent) => void
}

/** How tall the list may grow before it scrolls. */
const MAX_HEIGHT = 264
const GAP = 4
const MARGIN = 8

export function useAnchoredMenu(options: AnchoredMenuOptions): AnchoredMenu {
  const open = ref(false)
  const highlighted = ref(-1)
  const root = ref<HTMLElement | null>(null)
  const anchor = ref<HTMLElement | null>(null)
  const menu = ref<HTMLElement | null>(null)
  /** `position: fixed` viewport coordinates; see `place` for why. */
  const menuStyle = ref<Record<string, string>>({})

  function setElement(target: Ref<HTMLElement | null>) {
    return (el: Element | ComponentPublicInstance | null): void => {
      target.value = (el as HTMLElement | null) ?? null
    }
  }

  /**
   * Pins the list to the control.
   *
   * The list is fixed and teleported to the document body rather than positioned
   * inside the component. Both halves are load-bearing:
   *
   * - Cards clip their children (`overflow: hidden`, for their rounded corners), so
   *   a list laid out inside one would be cut off at the card's edge.
   * - Every view and card carries an entry animation with `both` fill-mode, and a
   *   finished `transform` — even the identity matrix it settles on — makes that
   *   element the containing block for fixed descendants. Resolved against a card
   *   instead of the viewport, the control's viewport coordinates put the list in
   *   the wrong place entirely; the body has no such ancestor.
   *
   * It follows the control on scroll and resize.
   */
  function place(): void {
    let box = anchor.value?.getBoundingClientRect()
    if (!box) return

    // A control that is not fully in view — opened from the keyboard, or right
    // after the page scrolled — is brought back first: a list pinned to a box
    // outside the window would hang off the edge of it.
    if (box.top < MARGIN || box.bottom > window.innerHeight - MARGIN) {
      anchor.value?.scrollIntoView({ block: 'nearest' })
      box = anchor.value?.getBoundingClientRect() ?? box
    }

    const below = window.innerHeight - box.bottom - GAP
    const above = box.top - GAP
    // Flip up only when there is genuinely more room there, so a list that would
    // otherwise poke out of the window bottom opens upwards instead.
    const flip = below < Math.min(MAX_HEIGHT, 120) && above > below
    const room = Math.max(64, Math.min(MAX_HEIGHT, flip ? above : below))
    const wanted = Math.max(box.width, options.minWidth?.() ?? 0)
    const width = Math.max(160, Math.min(wanted, window.innerWidth - MARGIN * 2))

    menuStyle.value = {
      left: `${Math.max(MARGIN, Math.min(box.left, window.innerWidth - width - MARGIN))}px`,
      width: `${width}px`,
      maxHeight: `${room}px`,
      ...(flip
        ? { bottom: `${Math.max(MARGIN, window.innerHeight - box.top + GAP)}px` }
        : { top: `${Math.min(box.bottom + GAP, window.innerHeight - MARGIN - 64)}px` })
    }
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as Node
    // The list is teleported out of the component, so it is not inside `root` and
    // has to be tested separately.
    if (!root.value?.contains(target) && !menu.value?.contains(target)) close()
  }

  function close(): void {
    open.value = false
  }

  function scrollHighlightedIntoView(): void {
    void menu.value
      ?.querySelectorAll('.picker-item')
      [highlighted.value]?.scrollIntoView({ block: 'nearest' })
  }

  function move(delta: number): void {
    if (!open.value) {
      open.value = true
      return
    }
    const count = options.count()
    if (!count) return
    highlighted.value = (highlighted.value + delta + count) % count
    scrollHighlightedIntoView()
  }

  /**
   * Points the highlight at the row the control already holds.
   *
   * Called on open, and by a control whose contents the user can type into: a
   * highlight left over from the previous contents would turn Enter into "replace
   * what I just typed with something else".
   */
  function syncHighlight(): void {
    setHighlight(options.selected())
  }

  /** Puts the highlight on `index`, held inside the list. */
  function setHighlight(index: number): void {
    const count = options.count()
    highlighted.value = count ? Math.min(Math.max(index, 0), count - 1) : 0
  }

  function toggle(): void {
    open.value = !open.value
  }

  function choose(index: number): void {
    options.onPick(index)
    close()
    // Focus back on the control, so a keyboard user carries on from where they
    // were rather than from the top of the page.
    anchor.value?.focus()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      close()
      return
    }
    if (event.key === 'Tab') {
      // Leaving the control closes the list, but the focus change itself is left
      // alone: trapping Tab inside a dropdown is worse than closing it.
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The control is often a text box, where the arrows are needed to move
      // inside the text; they only take over once the list is open.
      if (!open.value) {
        open.value = true
        return
      }
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' && open.value) {
      const index = highlighted.value
      if (index < 0 || index >= options.count()) return
      event.preventDefault()
      choose(index)
    }
  }

  watch(open, (value) => {
    if (value) {
      syncHighlight()
      place()
      // Capture phase, so a click anywhere outside closes the list before it does
      // whatever it was going to do — including clicking the control itself.
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('scroll', place, true)
      window.addEventListener('resize', place)
    } else {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  })

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  })

  return {
    open,
    highlighted,
    menuStyle,
    bindRoot: setElement(root),
    bindAnchor: setElement(anchor),
    bindMenu: setElement(menu),
    toggle,
    close,
    choose,
    setHighlight,
    onKeydown
  }
}
