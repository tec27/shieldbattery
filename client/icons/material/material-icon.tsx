import React from 'react'
import styled from 'styled-components'
import { useObservedDimensions } from '../../dom/dimension-hooks'
import { standardEasing } from '../../material/curve-constants'

export const IconRoot = styled.span<{ $size: number; $filled: boolean; $invertColor: boolean }>`
  font-family: 'Material Symbols Outlined';
  font-weight: normal;
  font-style: normal;
  font-size: ${props => props.$size}px;
  line-height: 1;
  letter-spacing: normal;
  text-transform: none;
  display: inline-block;
  white-space: nowrap;
  word-wrap: normal;
  direction: ltr;
  -webkit-font-feature-settings: 'liga';
  -webkit-font-smoothing: antialiased;

  width: ${props => props.$size}px;
  height: ${props => props.$size}px;

  font-variation-settings:
    'FILL' ${props => (props.$filled ? 1 : 0)},
    'opsz' ${props => Math.min(48, Math.max(20, props.$size))},
    'GRAD' ${props => (props.$invertColor ? 0 : -25)};

  transition: font-variation-settings 125ms ${standardEasing};
`

export interface MaterialIconProps {
  /**
   * The icon name or unicode value. These can be found on https://fonts.google.com/icons.
   */
  icon: string
  /**
   * The size of the icon (in pixels). Defaults to `24`.
   */
  size?: number
  /**
   * Whether the icon should be filled or outlined. Defaults to `true` (filled).
   */
  filled?: boolean
  /** Whether the colors are inverted (dark icon on light background). Defaults to `false`. */
  invertColor?: boolean
  className?: string
}

export const MaterialIcon = React.forwardRef(
  (
    { icon, size = 24, filled = true, invertColor = false, className }: MaterialIconProps,
    ref: React.ForwardedRef<HTMLSpanElement>,
  ) => {
    return (
      <IconRoot
        ref={ref}
        className={className}
        aria-hidden={true}
        $size={size}
        $filled={filled}
        $invertColor={invertColor}>
        {icon}
      </IconRoot>
    )
  },
)

const AutoSizeContainer = styled.div`
  width: 100%;
  height: auto;
`

/**
 * A `MaterialIcon` that will size itself to fit its container (by width).
 *
 * **Note:** `className` will be applied to the container, not the icon itself.
 */
export const AutoSizeMaterialIcon = React.forwardRef(
  (
    { className, ...iconProps }: Omit<MaterialIconProps, 'size'>,
    ref: React.ForwardedRef<HTMLSpanElement>,
  ) => {
    const [containerRef, size] = useObservedDimensions()
    return (
      <AutoSizeContainer ref={containerRef} className={className}>
        {size ? (
          <MaterialIcon {...iconProps} size={Math.floor(size?.width)} ref={ref} />
        ) : undefined}
      </AutoSizeContainer>
    )
  },
)
