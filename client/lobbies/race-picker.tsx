import React, { useMemo } from 'react'
import styled from 'styled-components'
import { AssignedRaceChar, RaceChar } from '../../common/races'
import { useButtonState } from '../material/button'
import { buttonReset } from '../material/button-reset'
import { standardEasing } from '../material/curve-constants'
import { Ripple } from '../material/ripple'
import { colorDividers, colorTextFaint, getRaceColor } from '../styles/colors'
import { RaceIcon } from './race-icon'

export const RACE_PICKER_SIZE_MEDIUM = 'MEDIUM'
export const RACE_PICKER_SIZE_LARGE = 'LARGE'

export enum RacePickerSize {
  Medium = 'medium',
  Large = 'large',
}

export const RaceButton = styled.button<{
  $size: RacePickerSize
  $race: RaceChar
  $active: boolean
  $allowInteraction: boolean
}>`
  ${buttonReset};

  display: inline-block;
  vertical-align: middle;
  width: ${props => (props.$size === RacePickerSize.Medium ? '36px' : '48px')};
  height: ${props => (props.$size === RacePickerSize.Medium ? '36px' : '48px')};
  min-height: ${props => (props.$size === RacePickerSize.Medium ? '32px' : '44px')};
  padding: ${props => (props.$allowInteraction ? '0' : '2px')};

  border: ${props => (props.$allowInteraction ? '2px solid currentColor' : 'none')};
  border-radius: 8px;

  &:not(:first-child) {
    margin-left: 4px;
  }

  --sb-race-color: ${props => getRaceColor(props.$race)};
  color: ${props => (props.$active ? 'var(--sb-race-color)' : colorTextFaint)};

  &:hover,
  &:active {
    color: var(--sb-race-color);
  }

  &:disabled {
    color: ${props => (props.$active ? 'var(--sb-race-color)' : colorTextFaint)};
  }
`

export const StyledRaceIcon = styled(RaceIcon)<{
  $size: RacePickerSize
}>`
  display: inline-block;
  width: ${props => (props.$size === RacePickerSize.Medium ? '32px' : '44px')};
  height: ${props => (props.$size === RacePickerSize.Medium ? '32px' : '44px')};
  margin: auto;
  overflow: hidden;

  fill: currentColor;
  transition: color 150ms ${standardEasing};
`

const HiddenRaceIcon = styled.span`
  position: relative;
  display: inline-block;
  vertical-align: middle;
  width: 36px;
  height: 36px;
  min-height: 32px;
  padding: 2px;

  &:not(:first-child) {
    margin-left: 4px;
  }

  &::after {
    content: '';
    position: absolute;
    left: calc(50% - 6px);
    top: calc(50% - 6px);
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background-color: ${colorDividers};
  }
`

export type RacePickerOnSetFunc<AllowRandom extends boolean | undefined> = AllowRandom extends false
  ? (race: AssignedRaceChar) => void
  : (race: RaceChar) => void

export interface RacePickerProps<AllowRandom extends boolean | undefined> {
  /** The currently selected race. */
  race: RaceChar
  /** Races to hide in the picker (and make un-selectable). */
  hiddenRaces?: RaceChar[]
  size?: RacePickerSize
  allowRandom?: AllowRandom
  onSetRace?: RacePickerOnSetFunc<AllowRandom>
  allowInteraction?: boolean
  className?: string
}

export const RacePicker = React.forwardRef(
  <AllowRandom extends boolean | undefined>(
    {
      race,
      hiddenRaces,
      size = RacePickerSize.Medium,
      allowRandom = true,
      onSetRace,
      allowInteraction = true,
      className,
    }: RacePickerProps<AllowRandom>,
    ref: React.ForwardedRef<HTMLButtonElement>,
  ) => {
    const [onSetZ, onSetP, onSetT, onSetR] = useMemo(() => {
      if (!onSetRace) {
        return [undefined, undefined, undefined, undefined]
      } else {
        return [
          () => onSetRace('z'),
          () => onSetRace('p'),
          () => onSetRace('t'),
          () => onSetRace('r' as any),
        ]
      }
    }, [onSetRace])

    const [zergButtonProps, zergRippleRef] = useButtonState({
      disabled: !allowInteraction,
      onClick: onSetZ,
    })
    const [protossButtonProps, protossRippleRef] = useButtonState({
      disabled: !allowInteraction,
      onClick: onSetP,
    })
    const [terranButtonProps, terranRippleRef] = useButtonState({
      disabled: !allowInteraction,
      onClick: onSetT,
    })
    const [randomButtonProps, randomRippleRef] = useButtonState({
      disabled: !allowInteraction,
      onClick: onSetR,
    })

    const races: RaceChar[] = allowRandom ? ['z', 'p', 't', 'r'] : ['z', 'p', 't']
    const buttonProps = [zergButtonProps, protossButtonProps, terranButtonProps, randomButtonProps]
    const rippleRefs = [zergRippleRef, protossRippleRef, terranRippleRef, randomRippleRef]

    return (
      <div className={className}>
        {races.map((r, i) =>
          hiddenRaces?.includes(r) ? (
            <HiddenRaceIcon key={r} />
          ) : (
            <RaceButton
              key={r}
              type='button'
              $size={size}
              $race={r}
              $active={r === race}
              $allowInteraction={allowInteraction}
              {...buttonProps[i]}>
              <StyledRaceIcon race={r} applyRaceColor={false} $size={size} />
              <Ripple ref={rippleRefs[i]} disabled={!allowInteraction} />
            </RaceButton>
          ),
        )}
      </div>
    )
  },
)
