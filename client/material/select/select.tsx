import React, { useCallback, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { UseTransitionProps } from 'react-spring'
import styled from 'styled-components'
import { MaterialIcon } from '../../icons/material/material-icon'
import { useKeyListener } from '../../keyboard/key-listener'
import { useValueAsRef } from '../../state-hooks'
import { amberA400, background300, colorTextFaint, colorTextPrimary } from '../../styles/colors'
import { buttonReset } from '../button-reset'
import { standardEasing } from '../curve-constants'
import { InputBase } from '../input-base'
import { InputError } from '../input-error'
import { FloatingLabel } from '../input-floating-label'
import { InputUnderline } from '../input-underline'
import { MenuList } from '../menu/menu'
import { isSelectableMenuItem } from '../menu/menu-item-symbol'
import { Popover, useAnchorPosition, usePopoverController } from '../popover'
import { defaultSpring } from '../springs'

const SPACE = 'Space'
const ENTER = 'Enter'
const ENTER_NUMPAD = 'NumpadEnter'

const SelectContainer = styled.button<{ disabled?: boolean; $focused?: boolean; $dense?: boolean }>`
  ${buttonReset};
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  position: relative;
  width: 100%;
  height: ${props => (props.$dense ? '40px' : '56px')};
  padding: 0;
  cursor: ${props => (props.disabled ? 'default' : 'pointer')};
  font-size: 16px;
  line-height: 20px;
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 4px 4px 0 0;
  contain: layout paint style;
  transition: background-color 150ms linear;

  &:focus {
    outline: none;
  }

  ${props =>
    !props.disabled
      ? `
        &:hover {
          background-color: rgba(255, 255, 255, 0.12);
        }
      `
      : ''}

  ${props =>
    props.$focused
      ? `
        background-color: rgba(255, 255, 255, 0.16) !important;
      `
      : ''}
`

const DisplayValue = styled(InputBase)`
  display: flex;
  align-items: center;
`

const Icon = styled.span<{
  $disabled?: boolean
  $focused?: boolean
  $opened?: boolean
  $dense?: boolean
}>`
  position: absolute;
  top: 50%;
  right: ${props => (props.$dense ? '8px' : '12px')};
  width: 24px;
  height: 24px;
  margin-left: 4px;
  pointer-events: none;
  transform: translate3d(0, -50%, 0) ${props => (props.$opened ? 'rotate(180deg)' : '')};
  transition: transform 150ms ${standardEasing};

  & > svg {
    width: 24px;
    height: 24px;
    ${props => {
      let color
      if (props.$disabled) {
        color = colorTextFaint
      } else if (props.$focused) {
        color = amberA400
      } else {
        color = colorTextPrimary
      }

      return `color: ${color}`
    }};
  }
`

const StyledMenuList = styled(MenuList)<{ $overlayWidth: number }>`
  width: ${props => props.$overlayWidth}px;
  background-color: ${background300};
`

export interface SelectProps {
  /**
   * Selectable options to display.
   * @see ./option.tsx
   */
  children: React.ReactNode
  /**
   * The current value of the input. Will be matched against the children's values using
   * `compareValues`.
   */
  value: unknown
  /**
   * An optional class string to apply to the root element.
   */
  className?: string
  /**
   * An optional id to use for the interactable element.
   */
  id?: string
  /**
   * Whether or not errors are possible. If they are not possible, no error text will ever be
   * shown and no space will be reserved for it next to the input. Defaults to `true`.
   */
  allowErrors?: boolean
  /**
   * Error text to show (`allowErrors` must be true for this to work).
   */
  errorText?: string
  /** Whether the input should be styled in a more compact way (defaults to false). */
  dense?: boolean
  /**
   * A label to include with the input, specifying what the input is for to users.
   */
  label?: string
  /** Whether or not the Select is currently reacting to user input. */
  disabled?: boolean
  /** Value to use for the `tabindex` form attribute. */
  tabIndex?: number
  /**
   * Callback whenever the current value of the input has changed.
   */
  onChange: (value: any) => void
  /**
   * Called to compare two input values. Optional, defaults to `Object.is`.
   */
  compareValues?: (a: any, b: any) => boolean
}

export interface SelectRef {
  /** Focuses the Select. */
  focus: () => void
  /** Unfocuses the Select. */
  blur: () => void
}

const MENU_TRANSITION: UseTransitionProps<boolean> = {
  from: { opacity: 0, scaleY: 0.5 },
  enter: { opacity: 1, scaleY: 1 },
  leave: { opacity: 0, scaleY: 0 },
  config: (item, index, phase) => key =>
    phase === 'leave' || key === 'opacity' ? { ...defaultSpring, clamp: true } : defaultSpring,
}

export const Select = React.forwardRef<SelectRef, SelectProps>(
  (
    {
      children,
      value,
      className,
      allowErrors = true,
      errorText,
      dense = false,
      label,
      disabled,
      tabIndex,
      onChange,
      compareValues = Object.is,
      id: propsId,
    },
    forwardedRef,
  ) => {
    const hookId = useId()
    const id = propsId ?? hookId
    const [focused, setFocused] = useState(false)
    const inputRef = useRef<HTMLButtonElement>()

    const [opened, openSelect, closeSelect] = usePopoverController()
    const [anchorRef, anchorX, anchorY] = useAnchorPosition('center', 'bottom')

    useImperativeHandle(forwardedRef, () => ({
      focus() {
        inputRef.current?.focus()
      },

      blur() {
        inputRef.current?.blur()
      },
    }))

    const focusedRef = useValueAsRef(focused)
    const openedRef = useValueAsRef(opened)

    const onOpen = useCallback(
      (event: React.MouseEvent) => {
        if (!disabled) {
          openSelect(event)
        }
      },
      [disabled, openSelect],
    )
    const onClose = useCallback(() => {
      closeSelect()
      inputRef.current?.focus()
    }, [closeSelect])
    const onFocus = useCallback(() => {
      if (!disabled) {
        setFocused(true)
      }
    }, [disabled])
    const onBlur = useCallback(() => {
      if (!openedRef.current) {
        // If we're opened, leave isFocused since we'll be reassigning focus on close
        setFocused(false)
      }
    }, [openedRef])
    const onOptionChanged = useCallback(
      (index: number) => {
        if (onChange) {
          const activeChild = React.Children.toArray(children)[index]
          onChange((activeChild as React.ReactElement).props.value)
        }
        onClose()
      },
      [onChange, onClose, children],
    )
    useKeyListener({
      onKeyDown: (event: KeyboardEvent) => {
        if (!focusedRef.current) return false

        if (!openedRef.current) {
          if (event.code === SPACE || event.code === ENTER || event.code === ENTER_NUMPAD) {
            openSelect(event)
            return true
          }
        }

        return false
      },
    })

    const multiplexRefs = useCallback(
      (elem: HTMLButtonElement | null) => {
        inputRef.current = elem !== null ? elem : undefined
        anchorRef(elem)
      },
      [anchorRef],
    )

    const [displayValue, options] = useMemo(() => {
      let displayText: string | undefined
      const options = React.Children.map(children, (child, index) => {
        if (!isSelectableMenuItem(child)) return child

        let selected = false
        if (value !== undefined && child.props.value !== undefined) {
          if (compareValues(value, child.props.value)) {
            displayText = child.props.text
            selected = true
          }
        }

        return React.cloneElement(child, {
          selected,
          onClick: () => onOptionChanged(index),
        })
      })

      return [displayText, options]
    }, [children, compareValues, onOptionChanged, value])

    const overlayWidth = inputRef.current?.offsetWidth ?? 0

    return (
      <div className={className}>
        <SelectContainer
          ref={multiplexRefs}
          id={id}
          type='button'
          disabled={disabled}
          $focused={focused}
          $dense={dense}
          tabIndex={disabled ? undefined : (tabIndex ?? 0)}
          onFocus={onFocus}
          onBlur={onBlur}
          onClick={onOpen}>
          {label ? (
            <FloatingLabel
              htmlFor={id}
              $hasValue={value !== undefined}
              $dense={dense}
              $focused={focused}
              $disabled={disabled}
              $error={!!errorText}>
              {label}
            </FloatingLabel>
          ) : null}
          <DisplayValue as='span' $floatingLabel={!!label} $disabled={disabled} $dense={dense}>
            {displayValue}
          </DisplayValue>
          <Icon $opened={opened} $focused={focused} $disabled={disabled} $dense={dense}>
            <MaterialIcon icon='arrow_drop_down' />
          </Icon>
          <InputUnderline focused={focused} error={!!errorText} disabled={disabled} />
        </SelectContainer>
        {allowErrors ? <InputError error={errorText} /> : null}
        <Popover
          open={opened}
          onDismiss={onClose}
          anchorX={anchorX ?? 0}
          anchorY={anchorY ?? 0}
          originX='center'
          originY='top'
          transitionProps={MENU_TRANSITION}>
          <StyledMenuList $overlayWidth={overlayWidth} dense={dense}>
            {options}
          </StyledMenuList>
        </Popover>
      </div>
    )
  },
)
