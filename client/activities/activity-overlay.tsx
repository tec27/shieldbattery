import keycode from 'keycode'
import React, { useCallback, useRef } from 'react'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import styled from 'styled-components'
import { assertUnreachable } from '../../common/assert-unreachable'
import { FocusTrap } from '../dom/focus-trap'
import { KeyListenerBoundary, useKeyListener } from '../keyboard/key-listener'
import { accelerateEasing, decelerateEasing } from '../material/curve-constants'
import { isHandledDismissalEvent } from '../material/dismissal-events'
import { shadow8dp } from '../material/shadows'
import { zIndexBackdrop, zIndexSideNav } from '../material/zindex'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { background700, dialogScrim } from '../styles/colors'
import { closeOverlay } from './action-creators'
import { ActivityOverlayState } from './activity-overlay-reducer'
import { ActivityOverlayType } from './activity-overlay-type'

const { FindMatch, Lobby, BrowseLocalMaps, BrowseServerMaps, BrowseLocalReplays } = IS_ELECTRON
  ? {
      FindMatch: require('../matchmaking/find-match').FindMatch,
      Lobby: require('../lobbies/lobby-activity-overlay').LobbyActivityOverlay,
      BrowseLocalMaps: require('../maps/browse-local-maps').BrowseLocalMaps,
      BrowseServerMaps: require('../maps/browse-server-maps').default,
      BrowseLocalReplays: require('../replays/browse-local-replays').BrowseLocalReplays,
    }
  : {
      FindMatch: () => undefined,
      Lobby: () => undefined,
      BrowseLocalMaps: () => undefined,
      BrowseServerMaps: () => undefined,
      BrowseLocalReplays: () => undefined,
    }

const ESCAPE = keycode('escape')

const transitionNames = {
  enter: 'enter',
  enterActive: 'enterActive',
  exit: 'exit',
  exitActive: 'exitActive',
}

const Scrim = styled.div`
  position: fixed;
  left: 0;
  top: var(--sb-system-bar-height, 0);
  right: 0;
  bottom: 0;
  opacity: 0.42;
  background-color: ${dialogScrim};
  z-index: ${zIndexBackdrop};
  will-change: opacity;

  -webkit-app-region: no-drag;
`

const Overlay = styled.div`
  ${shadow8dp};
  position: fixed;
  right: 0;
  top: var(--sb-system-bar-height, 0);
  bottom: 0;
  width: 60%;
  min-width: 448px;
  max-width: 768px;
  background-color: ${background700};
  contain: strict;
  z-index: ${zIndexSideNav};

  -webkit-app-region: no-drag;
`

const Container = styled.div`
  &.enter ${Overlay} {
    transform: translate3d(100%, 0, 0);
  }

  &.enter ${Scrim} {
    opacity: 0;
  }

  &.enterActive ${Overlay} {
    transform: translate3d(0, 0, 0);
    /* transition rule should always be put in the active class as there's a bug that can happen
    if it's not; see this issue: https://github.com/reactjs/react-transition-group/issues/10 */
    transition: transform 350ms ${decelerateEasing};
  }

  &.enterActive ${Scrim} {
    opacity: 0.42;
    transition: opacity 250ms linear;
  }

  &.exit {
    pointer-events: none;
  }

  &.exit ${Overlay} {
    transform: translate3d(0, 0, 0);
  }

  &.exit ${Scrim} {
    opacity: 0.42;
  }

  &.exitActive ${Overlay} {
    transform: translate3d(100%, 0, 0);
    transition: transform 250ms ${accelerateEasing};
  }

  &.exitActive ${Scrim} {
    opacity: 0;
    transition: opacity 200ms linear;
  }
`

function getOverlayComponent(state: ActivityOverlayState) {
  switch (state.type) {
    case ActivityOverlayType.FindMatch:
      return FindMatch
    case ActivityOverlayType.Lobby:
      return Lobby
    case ActivityOverlayType.BrowseLocalMaps:
      return BrowseLocalMaps
    case ActivityOverlayType.BrowseServerMaps:
      return BrowseServerMaps
    case ActivityOverlayType.BrowseLocalReplays:
      return BrowseLocalReplays
    default:
      return assertUnreachable(state.type)
  }
}

const ActivityOverlayContent = React.forwardRef<HTMLDivElement, { state: ActivityOverlayState }>(
  ({ state }, ref) => {
    const dispatch = useAppDispatch()
    const onScrimClick = useCallback(
      (event: React.MouseEvent) => {
        if (!isHandledDismissalEvent(event.nativeEvent)) {
          dispatch(closeOverlay())
        }
      },
      [dispatch],
    )
    useKeyListener({
      onKeyDown(event) {
        if (event.keyCode === ESCAPE) {
          dispatch(closeOverlay())
          return true
        }

        return false
      },
    })

    const focusableRef = useRef<HTMLSpanElement>(null)

    const OverlayComponent = getOverlayComponent(state)
    return (
      <Container key={'overlay'} ref={ref}>
        <FocusTrap focusableRef={focusableRef}>
          <Scrim onClick={onScrimClick} />
          <Overlay>
            <span ref={focusableRef} tabIndex={-1} />
            <OverlayComponent key={state.id} {...state.initData} />
          </Overlay>
        </FocusTrap>
      </Container>
    )
  },
)

export function ActivityOverlay() {
  const nodeRef = useRef(null)
  const state = useAppSelector(state => state.activityOverlay.history.at(-1))

  return (
    <TransitionGroup>
      {state ? (
        <CSSTransition
          classNames={transitionNames}
          timeout={{ enter: 350, exit: 250 }}
          nodeRef={nodeRef}>
          <KeyListenerBoundary>
            <ActivityOverlayContent key='overlay' state={state} ref={nodeRef} />
          </KeyListenerBoundary>
        </CSSTransition>
      ) : null}
    </TransitionGroup>
  )
}
