import React from 'react'
import styled, { css, keyframes } from 'styled-components'
import { colorTextSecondary } from '../styles/colors'

const bounce = keyframes`
  0%, 80%, 100% {
    transform: scale(0);
    opacity: 0;
  }

  30%, 50% {
    transform: scale(1.0);
    opacity: 1;
  }
`

const makeVisible = keyframes`
  to {
    visibility: visible;
  }
`

const LOADING_SHOW_DELAY_MS = 750

const delayedShowCss = css`
  animation: 0s linear ${LOADING_SHOW_DELAY_MS}ms forwards ${makeVisible};
  visibility: hidden;
`

const Root = styled.div<{ $showImmediately?: boolean }>`
  height: 24px;
  padding: 4px 8px;
  color: ${colorTextSecondary};
  opacity: 0.7;

  ${props => (!props.$showImmediately ? delayedShowCss : '')};
`

interface DotProps {
  /** How long to delay the animation for, as a CSS unit string. */
  $delay: string
}

const Dot = styled.div<DotProps>`
  width: 16px;
  height: 16px;
  display: inline-block;

  background-color: currentColor;
  border-radius: 50%;
  animation: ${bounce} 1.6s infinite cubic-bezier(0.7, 0, 0.3, 1);
  animation-delay: ${props => props.$delay};

  & + & {
    margin-left: 6px;
  }
`

interface DotsIndicatorProps {
  /**
   * Whether or not to show the progress indicator immediately. If false, there will be a slight
   * delay before actually showing the indicator, which tends to make UIs feel more responsive if
   * they only have a very small delay before loading has completed.
   */
  showImmediately?: boolean

  /** A class string to add to the root element. */
  className?: string
}

export function DotsIndicator({ showImmediately = false, className }: DotsIndicatorProps) {
  return (
    <Root className={className} $showImmediately={showImmediately}>
      <Dot $delay='-1200ms' />
      <Dot $delay='-1050ms' />
      <Dot $delay='-900ms' />
      <Dot $delay='-750ms' />
    </Root>
  )
}

export default DotsIndicator

const LoadingArea = styled.div<{ $showImmediately?: boolean }>`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  padding: 16px 0;

  ${props => (!props.$showImmediately ? delayedShowCss : '')};
`

export function LoadingDotsArea({ showImmediately = false, className }: DotsIndicatorProps) {
  return (
    <LoadingArea className={className} $showImmediately={showImmediately}>
      <DotsIndicator showImmediately={true} />
    </LoadingArea>
  )
}
