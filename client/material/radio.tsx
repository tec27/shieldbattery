import React, { InputHTMLAttributes, useId } from 'react'
import styled from 'styled-components'
import { amberA400, colorTextFaint, colorTextPrimary, colorTextSecondary } from '../styles/colors'
import { body1, overline } from '../styles/typography'
import { useButtonState } from './button'
import { standardEasing } from './curve-constants'
import { Ripple } from './ripple'

const noop = () => {}

const RadioGroupContainer = styled.div`
  display: flex;
  flex-direction: column;

  // Align the left side of the radio group with the outer circle of the radio icon.
  margin-left: -14px;
`

const RadioOverline = styled.div`
  ${overline};
  color: ${colorTextSecondary};

  padding: 4px 0;
`

export interface RadioGroupProps<T> {
  children: Array<ReturnType<typeof RadioButton> | null | undefined>
  value: T
  name?: string
  label?: React.ReactNode
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void
  className?: string
}

export function RadioGroup<T>({
  children,
  value,
  name,
  label,
  onChange,
  className,
}: RadioGroupProps<T>) {
  const radioButtons = React.Children.map(children, (child, i) => {
    if (!child || typeof child !== 'object' || !('props' in child)) {
      return child
    }

    const isSelected = value === (child.props as RadioButtonProps<T>).value
    return React.cloneElement(child, {
      key: `button-${i}`,
      name,
      selected: isSelected,
    })
  })

  return (
    <>
      {label ? <RadioOverline>{label}</RadioOverline> : null}
      <RadioGroupContainer className={className} onChange={onChange}>
        {radioButtons}
      </RadioGroupContainer>
    </>
  )
}

interface RadioButtonProps<T> {
  label: React.ReactNode
  value: T
  disabled?: boolean
  inputProps?: InputHTMLAttributes<HTMLInputElement>
  className?: string
  /**
   * The name of the radio button, used mostly in forms. This will be set by the containing Radio
   * component and should not be passed directly.
   */
  name?: string
  /**
   * Whether or not the radio button is the selected one. This will be set by the containing Radio
   * component and should not be passed directly.
   */
  selected?: boolean
}

const RadioButtonContainer = styled.div`
  position: relative;

  display: inline-flex;
  align-items: center;
  gap: 4px;

  input {
    position: absolute;
    left: 0;
    top: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    margin: 0;

    appearance: none;
    outline: none;

    cursor: pointer;
  }
`

const IconContainer = styled.div<{ $disabled?: boolean; $selected?: boolean }>`
  flex-shrink: 0;
  position: relative;
  width: 48px;
  height: 48px;

  color: ${props => {
    if (props.$disabled) return colorTextFaint
    else if (props.$selected) return amberA400
    else return colorTextSecondary
  }};
`

const RadioIcon = styled.div<{ $selected?: boolean }>`
  position: relative;
  top: 14px;
  width: 20px;
  height: 20px;
  margin: auto;

  border-radius: 50%;

  // outer circle
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    width: 20px;
    height: 20px;

    border: 2px solid;
    border-radius: 50%;
    border-color: currentColor;
  }

  // inner circle
  &::after {
    content: '';
    position: absolute;
    top: 5px;
    left: 5px;
    width: 10px;
    height: 10px;

    border-radius: 50%;
    background-color: currentColor;

    transform: ${props => (props.$selected ? 'scale(1)' : 'scale(0)')};
    transition: transform 150ms ${standardEasing};
  }
`

const StyledRipple = styled(Ripple)`
  margin: 4px;
  border-radius: 50%;
`

const Label = styled.label<{ $disabled?: boolean }>`
  ${body1};

  flex-grow: 1;
  padding: 4px 0;

  color: ${props => (props.$disabled ? colorTextFaint : colorTextPrimary)};
`

export const RadioButton = React.memo(
  <T extends NonNullable<InputHTMLAttributes<HTMLInputElement>['value']>>({
    label,
    value,
    disabled,
    inputProps,
    name,
    selected,
  }: RadioButtonProps<T>) => {
    const id = useId()

    const [buttonProps, rippleRef] = useButtonState({ disabled })

    const internalInputProps = {
      type: 'radio',
      id,
      value,
      name,
      checked: selected,
      disabled,
      // `onChange` is handled in the RadioGroup so we just noop it here to get rid of the warning.
      onChange: noop,
    }

    return (
      <RadioButtonContainer {...buttonProps}>
        <IconContainer $disabled={disabled} $selected={selected}>
          <RadioIcon $selected={selected} />
          <StyledRipple ref={rippleRef} disabled={disabled} />
        </IconContainer>
        <Label htmlFor={id} $disabled={disabled}>
          {label}
        </Label>
        <input {...inputProps} {...internalInputProps} />
      </RadioButtonContainer>
    )
  },
)
