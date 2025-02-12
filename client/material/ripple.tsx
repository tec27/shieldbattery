import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import styled, { css, keyframes } from 'styled-components'
import { useForceUpdate, usePrevious, useValueAsRef } from '../state-hooks'
import { standardEasing } from './curve-constants'

const RIPPLE_PADDING = 8
const INITIAL_ORIGIN_SCALE = 0.1

const TRANSLATE_IN_DURATION_MS = 225
const OPACITY_IN_DURATION_MS = 75
const DEACTIVATION_TIMEOUT_MS = Math.max(TRANSLATE_IN_DURATION_MS, OPACITY_IN_DURATION_MS)

const OPACITY_OUT_DURATION_MS = 150
const FG_DEACTIVATION_MS = OPACITY_OUT_DURATION_MS

const fgRadiusIn = keyframes`
  from {
    animation-timing-function: ${standardEasing};
    transform: translate(var(--sb-ripple-translate-start, 0)) scale(1);
  }

  to {
    transform: translate(var(--sb-ripple-translate-end, 0))
      scale(var(--sb-ripple-fg-scale, 1));
  }
`

const fgOpacityIn = keyframes`
  from {
    animation-timing-function: linear;
    opacity: 0;
  }

  to {
    opacity: var(--sb-ripple-fg-opacity, 0);
  }
`

const fgOpacityOut = keyframes`
  from {
    animation-timing-function: linear;
    opacity: var(--sb-ripple-fg-opacity, 0);
  }

  to {
    opacity: 0;
  }
`

const RippleRoot = styled.div<{
  $hovered: boolean
  $focused: boolean
  $activating: boolean
  $deactivating: boolean
}>`
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  position: absolute;

  contain: strict;
  overflow: hidden;
  pointer-events: none;

  --sb-ripple-fg-opacity: var(--sb-ripple-press-opacity, 0.12);

  // Used for "static" states: hover + focus
  &::before,
  // Used for dynamic activations: mouse/keyboard presses (note that this applies additively to
  // the static washes from ::before)
  &::after {
    position: absolute;
    content: '';

    background-color: var(--sb-ripple-color, currentColor);
    border-radius: 50%;
    opacity: 0;
  }

  &::before {
    top: calc(-50%);
    left: calc(-50%);
    width: 200%;
    height: 200%;

    transform: scale(var(--sb-ripple-fg-scale, 1));
    transition:
      opacity 15ms linear,
      background-color 15ms linear;
    z-index: 1;

    transition-duration: ${props => (props.$focused ? '75ms' : '15ms')};
    opacity: ${props => {
      if (props.$focused) {
        return 'var(--sb-ripple-focus-opacity, 0.12)'
      } else if (props.$hovered) {
        return 'var(--sb-ripple-hover-opacity, 0.04)'
      } else {
        return '0'
      }
    }};
  }

  &::after {
    top: 0px;
    left: 0px;
    width: var(--sb-ripple-fg-size, 100%);
    height: var(--sb-ripple-fg-size, 100%);

    transform: ${props =>
      props.$deactivating
        ? 'translate(var(--sb-ripple-translate-end, 0)) scale(var(--sb-ripple-fg-scale, 1))'
        : 'scale(0)'};
    transform-origin: center center;

    animation: ${props => {
      if (props.$activating) {
        return css`
          ${fgRadiusIn} ${TRANSLATE_IN_DURATION_MS}ms forwards,
                ${fgOpacityIn} ${OPACITY_IN_DURATION_MS}ms forwards
        `
      } else if (props.$deactivating) {
        return css`
          ${fgOpacityOut} ${OPACITY_OUT_DURATION_MS}ms
        `
      } else {
        return 'none'
      }
    }};
  }
`

export interface RippleProps {
  disabled?: boolean
  className?: string
}

/**
 * Controller for the ripple returned for a `ref`. Use this to forward relevant events (mouse,
 * keyboard, and focus events) to the ripple so that it can update and animate its state.
 */
export interface RippleController {
  /**
   * Activate the ripple. This should be called on `mousedown` events and any `keydown` events
   * that cause the element to be made active (an easy way to check this is to call
   * `HTMLElement.matches(':active')`).
   */
  onActivate(event?: React.MouseEvent | React.KeyboardEvent | MouseEvent | KeyboardEvent): void
  /**
   * Deactivate the ripple (causing it to complete its animation --> rest). This should be
   * called on the opposing events of `onActivate`, that is, `mouseup` and `keyup` events for
   * which `onActivate` was called.
   */
  onDeactivate(): void
  /**
   * Tell the ripple that the component it belongs to has been focused.
   */
  onFocus(): void
  /**
   * Tell the ripple that the component it belongs to is no longer focused.
   */
  onBlur(): void
  /**
   * Tell the ripple that the user has moused over the containing component.
   */
  onMouseEnter(): void
  /**
   * Tell the ripple that the user is no longer mousing over the containing component.
   */
  onMouseLeave(): void
}

interface ActivationState {
  isActivated?: boolean
  hasActivationAnimFinished?: boolean
  hasDeactivationAnimRun?: boolean
  activationEvent?: React.MouseEvent | React.KeyboardEvent
  wasActivatedByPointer?: boolean
  isProgrammatic?: boolean
}

interface RippleStyle extends React.CSSProperties {
  '--sb-ripple-fg-size'?: string
  '--sb-ripple-fg-scale'?: number
  '--sb-ripple-translate-start'?: string
  '--sb-ripple-translate-end'?: string
}

// Used to track which targets were activated during a single event so that only the innermost one
// displays a ripple activation
const activatedTargets: Array<EventTarget | null> = []

/**
 * A Material-Design-inspired ripple for showing touch/mouse/keyboard feedback on interactive
 * components. This component should be placed inside a parent that is `position: relative`, and
 * given a `ref` to store its controller in. Utilize the controller to forward relevant events from
 * the parent component into the Ripple.
 *
 * The visuals can be customized by either extending it with styled-components, or utilizing CSS
 * custom properties:
 *
 *   - `--sb-ripple-color` (defaults to `currentColor`)
 *   - `--sb-ripple-hover-opacity` (defaults to 0.04)
 *   - `--sb-ripple-focus-opacity` (defaults to 0.12)
 *   - `--sb-ripple-press-opacity` (defaults to 0.12)
 */
export const Ripple = React.memo(
  React.forwardRef<RippleController, RippleProps>(({ disabled, className }, ref) => {
    const rootRef = useRef<HTMLDivElement | null>(null)
    const disabledRef = useValueAsRef(disabled)

    const activationStateRef = useRef<ActivationState>({})
    const styleRef = useRef<RippleStyle>({})
    const activationTimerRef = useRef<ReturnType<typeof setTimeout>>()
    const fgDeactivationRemovalTimerRef = useRef<ReturnType<typeof setTimeout>>()
    const clearActivatedTargetsReqRef = useRef<number>()
    const runDeactivationReqRef = useRef<number>()

    const [focused, setFocused] = useState(false)
    const [hovered, setHovered] = useState(false)
    const startActivationRef = useRef(false)
    const [activating, setActivating] = useState(false)
    const [deactivating, setDeactivating] = useState(false)
    const wasActivating = usePrevious(activating)
    const wasDeactivating = usePrevious(deactivating)
    const forceUpdate = useForceUpdate()

    const doLayout: () => [frame?: DOMRect, initialSize?: number, fgScale?: number] =
      useCallback(() => {
        if (!rootRef.current) {
          return []
        }

        const frame = rootRef.current.getBoundingClientRect()
        const maxDim = Math.max(frame.height, frame.width)
        const hypotenuse = Math.sqrt(frame.width ** 2 + frame.height ** 2)
        const maxRadius = hypotenuse + RIPPLE_PADDING

        const initialSize = Math.floor(maxDim * INITIAL_ORIGIN_SCALE)
        const fgScale = maxRadius / initialSize

        styleRef.current['--sb-ripple-fg-size'] = `${initialSize}px`
        styleRef.current['--sb-ripple-fg-scale'] = fgScale

        return [frame, initialSize, fgScale]
      }, [])
    const animateActivation = useCallback(() => {
      const [frame, initialSize = 0] = doLayout()

      if (!frame) {
        // This should really never happen, as it implies we were somehow activated before rootRef
        // was set
        return
      }

      const { activationEvent, wasActivatedByPointer } = activationStateRef.current
      let startPoint: { x: number; y: number }
      if (wasActivatedByPointer) {
        startPoint = getNormalizedEventCoords(
          activationEvent as React.MouseEvent,
          { x: window.pageXOffset, y: window.pageYOffset },
          frame,
        )
      } else {
        startPoint = {
          x: frame.width / 2,
          y: frame.height / 2,
        }
      }
      // Center around starting point
      startPoint = {
        x: startPoint.x - initialSize / 2,
        y: startPoint.y - initialSize / 2,
      }
      // Finish at the center of the element
      const endPoint = {
        x: frame.width / 2 - initialSize / 2,
        y: frame.height / 2 - initialSize / 2,
      }

      styleRef.current['--sb-ripple-translate-start'] = `${startPoint.x}px, ${startPoint.y}px`
      styleRef.current['--sb-ripple-translate-end'] = `${endPoint.x}px, ${endPoint.y}px`

      if (activationTimerRef.current) {
        clearTimeout(activationTimerRef.current)
        activationTimerRef.current = undefined
      }
      if (fgDeactivationRemovalTimerRef.current) {
        clearTimeout(fgDeactivationRemovalTimerRef.current)
        fgDeactivationRemovalTimerRef.current = undefined
      }

      setDeactivating(false)
      startActivationRef.current = true
      // In case we weren't deactivating previously, we need to force an update as well in order
      // to start the animations
      forceUpdate()
    }, [doLayout, forceUpdate])

    const maybeRunDeactivation = useCallback(() => {
      // Called only after both: the activation animation has completed, and the pointing device
      // that caused the activation has been released
      const { hasDeactivationAnimRun, isActivated, hasActivationAnimFinished } =
        activationStateRef.current

      const activationHasEnded = hasDeactivationAnimRun || !isActivated

      if (activationHasEnded && hasActivationAnimFinished) {
        setActivating(false)
        activationStateRef.current = {}
      }
    }, [])
    const onActivationTimer = useCallback(() => {
      activationStateRef.current.hasActivationAnimFinished = true
      maybeRunDeactivation()
    }, [maybeRunDeactivation])

    useImperativeHandle(
      ref,
      () => ({
        onActivate(event?: React.MouseEvent | React.KeyboardEvent) {
          if (disabledRef.current) {
            return
          }

          const activationState = activationStateRef.current
          if (activationState.isActivated) {
            return
          }

          activationState.isActivated = true
          activationState.isProgrammatic = event === undefined
          activationState.activationEvent = event
          activationState.wasActivatedByPointer = event?.type === 'mousedown'

          const hasActivatedDescendant = event && activatedTargets.length
          if (hasActivatedDescendant) {
            // Let the descendant ripple instead of us (e.g. a button on a clickable card)
            activationStateRef.current = {}
            return
          }

          if (event) {
            activatedTargets.push(event.target)
          }

          animateActivation()

          if (!clearActivatedTargetsReqRef.current) {
            clearActivatedTargetsReqRef.current = requestAnimationFrame(() => {
              clearActivatedTargetsReqRef.current = undefined
              activatedTargets.length = 0
            })
          }
        },

        onDeactivate() {
          const { isActivated, isProgrammatic } = activationStateRef.current

          if (!isActivated) {
            return
          }

          if (!isProgrammatic && !runDeactivationReqRef.current) {
            runDeactivationReqRef.current = requestAnimationFrame(() => {
              runDeactivationReqRef.current = undefined

              activationStateRef.current.hasDeactivationAnimRun = true
              maybeRunDeactivation()
            })
          } else {
            activationStateRef.current = {}
          }
        },

        onFocus() {
          setFocused(true)
        },

        onBlur() {
          setFocused(false)
        },

        onMouseEnter() {
          setHovered(true)
        },

        onMouseLeave() {
          setHovered(false)
        },
      }),
      [disabledRef, animateActivation, maybeRunDeactivation],
    )

    const isStartingActivation = startActivationRef.current
    useLayoutEffect(() => {
      if (wasDeactivating && !deactivating) {
        // Ensure that layout happens after the classes change so that the activation animation
        // runs
        rootRef?.current?.getBoundingClientRect()
      }

      if (isStartingActivation && activationStateRef.current.isActivated) {
        startActivationRef.current = false
        setActivating(true)
        activationTimerRef.current = setTimeout(onActivationTimer, DEACTIVATION_TIMEOUT_MS)
      }
    }, [wasDeactivating, deactivating, isStartingActivation, onActivationTimer])
    useLayoutEffect(() => {
      if (wasActivating && !activating) {
        // Ensure that layout happens after the classes change so that the deactivation animation
        // runs
        rootRef?.current?.getBoundingClientRect()
        setDeactivating(true)
        fgDeactivationRemovalTimerRef.current = setTimeout(() => {
          setDeactivating(false)
        }, FG_DEACTIVATION_MS)
      }
    }, [wasActivating, activating])

    useEffect(() => {
      return () => {
        if (activationTimerRef.current) {
          clearTimeout(activationTimerRef.current)
          activationTimerRef.current = undefined
        }
        if (fgDeactivationRemovalTimerRef.current) {
          clearTimeout(fgDeactivationRemovalTimerRef.current)
          fgDeactivationRemovalTimerRef.current = undefined
        }
        if (clearActivatedTargetsReqRef.current) {
          cancelAnimationFrame(clearActivatedTargetsReqRef.current)
          clearActivatedTargetsReqRef.current = undefined
        }
        if (runDeactivationReqRef.current) {
          cancelAnimationFrame(runDeactivationReqRef.current)
          runDeactivationReqRef.current = undefined
        }
      }
    }, [])

    return (
      <RippleRoot
        ref={rootRef}
        className={className}
        style={styleRef.current}
        $hovered={!disabled && hovered}
        $focused={!disabled && focused}
        $activating={activating}
        $deactivating={deactivating}
      />
    )
  }),
)

function getNormalizedEventCoords(
  event: React.MouseEvent | undefined,
  pageOffset: { x: number; y: number },
  clientRect: DOMRect,
): { x: number; y: number } {
  if (!event) {
    return { x: 0, y: 0 }
  }

  return {
    x: event.pageX - (pageOffset.x + clientRect.left),
    y: event.pageY - (pageOffset.y + clientRect.top),
  }
}
