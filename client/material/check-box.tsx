import { rgba } from 'polished'
import React, { useCallback, useId, useRef, useState } from 'react'
import styled from 'styled-components'
import {
  alphaDisabled,
  alphaDividers,
  amberA400,
  colorBackground,
  colorDividers,
  colorTextFaint,
  colorTextPrimary,
  colorTextSecondary,
} from '../styles/colors'
import { standardEasing } from './curve-constants'

const BOX_WIDTH = 18
const BOX_HEIGHT = 18

const Root = styled.div<{ $disabled?: boolean }>`
  position: relative;
  height: auto;
  min-width: ${BOX_WIDTH}px;
  min-height: ${BOX_HEIGHT + 2}px;
  padding: 8px 0 8px 2px;

  display: flex;
  align-items: center;

  contain: layout style;
  line-height: ${BOX_HEIGHT + 2}px;
  overflow: visible;

  input {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;

    padding: 0;
    margin: 0;
    outline: 0;
    opacity: 0;

    cursor: pointer;
  }

  label {
    order: 2;
    margin-left: 10px; /* the box is 18px wide, so this hits a 4px multiple */
    line-height: 20px;
    pointer-events: none;
    ${props => (props.$disabled ? `color: ${colorTextFaint};` : '')}
  }
`

export const CheckIconContainer = styled.div<{
  $disabled?: boolean
  $checked?: boolean
  $focused?: boolean
}>`
  position: relative;
  order: 1;
  width: ${BOX_WIDTH}px;
  height: ${BOX_HEIGHT}px;
  pointer-events: none;
  background-color: ${props => {
    if (props.$focused && !props.$disabled && !props.$checked) return colorDividers
    else return 'transparent'
  }};
  flex-shrink: 0;

  &::before {
    position: absolute;
    top: ${props => (props.$focused && !props.$disabled ? '-8px' : '0')};
    left: ${props => (props.$focused && !props.$disabled ? '-8px' : '0')};
    bottom: ${props => (props.$focused && !props.$disabled ? '-8px' : '0')};
    right: ${props => (props.$focused && !props.$disabled ? '-8px' : '0')};
    display: block;

    background-color: ${props => {
      if (props.$disabled) return colorDividers
      else if (props.$checked && props.$focused) return rgba(amberA400, Number(alphaDividers))
      else return 'transparent'
    }};
    border-radius: 50%;
    content: '';
    transition:
      all 200ms ${standardEasing},
      background-color 150ms linear;
  }

  &::after {
    position: absolute;
    top: -8px;
    left: -8px;
    bottom: -8px;
    right: -8px;
    border: none;
    content: '';
  }
`

export const CheckIcon = styled.div<{
  $disabled?: boolean
  $checked?: boolean
  $focused?: boolean
}>`
  position: absolute;
  top: 0;
  left: 0;
  width: ${BOX_WIDTH}px;
  height: ${BOX_HEIGHT}px;
  border: 2px solid;
  border-radius: 2px;
  transition:
    border-color 200ms linear,
    background-color 200ms linear,
    opacity 150ms linear;

  background-color: ${props => {
    if (props.$checked && props.$disabled) return colorTextPrimary
    else if (props.$checked) return amberA400
    else return 'transparent'
  }};
  border-color: ${props => {
    if (props.$disabled) return colorTextPrimary
    else if (props.$checked) return amberA400
    else return colorTextSecondary
  }};
  opacity: ${props => {
    if (props.$disabled) return alphaDisabled
    else return '1'
  }};

  /*
    NOTE(tec27): This is a dumb hack that I learned from Angular Material. It renders a check mark
    by rendering a table element with no content but a transparent border on its bottom and right
    edge, and sizing the table such that its appropriate for our box size. This element can then be
    rotated in and will look correct.
  */
  &::after {
    position: absolute;
    left: ${BOX_WIDTH / 3 - 2}px;
    top: ${BOX_HEIGHT / 9 - 2}px;
    width: ${BOX_WIDTH / 3}px;
    height: ${(BOX_WIDTH * 2) / 3}px;
    display: table;

    border: 2px solid;
    border-color: ${props => (props.$checked ? colorBackground : 'transparent')};
    border-top: 0;
    border-left: 0;
    content: '';
    transform: ${props => (props.$checked ? 'rotate(45deg)' : 'rotate(-135deg)')};
    transition:
      border-color 150ms linear,
      transform 200ms ${standardEasing};
  }
`

export interface CheckBoxProps {
  checked: boolean
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void

  name?: string
  label?: React.ReactNode
  value?: string
  disabled?: boolean
  className?: string
  inputProps?: React.InputHTMLAttributes<HTMLInputElement>
}

export const CheckBox = React.forwardRef<HTMLInputElement, CheckBoxProps>(
  ({ name, checked, label, value, disabled, className, inputProps, onChange }, ref) => {
    const id = useId()
    const [isKeyboardFocused, setIsKeyboardFocused] = useState(false)
    const mouseActiveRef = useRef(false)
    const clearMouseActiveRef = useRef<ReturnType<typeof setTimeout>>()

    const onBlur = useCallback(() => {
      setIsKeyboardFocused(false)
    }, [])
    const onFocus = useCallback(() => {
      if (!mouseActiveRef.current) {
        setIsKeyboardFocused(true)
      }
    }, [])
    const onMouseDown = useCallback(() => {
      if (clearMouseActiveRef.current) {
        clearTimeout(clearMouseActiveRef.current)
      }
      clearMouseActiveRef.current = setTimeout(() => {
        mouseActiveRef.current = false
        clearMouseActiveRef.current = undefined
      }, 100)
      mouseActiveRef.current = true
    }, [])

    const labelElem = label ? <label htmlFor={id}>{label}</label> : undefined
    const inputElem = (
      <input
        {...inputProps}
        ref={ref}
        type='checkbox'
        id={id}
        checked={checked}
        name={name}
        value={value}
        disabled={disabled}
        onBlur={onBlur}
        onFocus={onFocus}
        onChange={onChange}
        onMouseDown={onMouseDown}
      />
    )

    return (
      <Root className={className} $disabled={disabled}>
        {inputElem}
        <CheckIconContainer $checked={checked} $focused={isKeyboardFocused} $disabled={disabled}>
          <CheckIcon $checked={checked} $focused={isKeyboardFocused} $disabled={disabled} />
        </CheckIconContainer>
        {labelElem}
      </Root>
    )
  },
)
