import keycode from 'keycode'
import { darken, rgba } from 'polished'
import PropTypes from 'prop-types'
import React from 'react'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import styled from 'styled-components'
import { amberA400, colorTextFaint, colorTextSecondary } from '../styles/colors'
import { body1, caption } from '../styles/typography'
import { standardEasing } from './curve-constants'

const transitionNames = {
  enter: 'enter',
  enterActive: 'enterActive',
  exit: 'exit',
  exitActive: 'exitActive',
}

const LEFT = keycode('left')
const RIGHT = keycode('right')
const HOME = keycode('home')
const END = keycode('end')

const MOUSE_LEFT = 1

const THUMB_WIDTH_PX = 20
const THUMB_HEIGHT_PX = 20
const BALLOON_WIDTH_PX = 28
const BALLOON_HEIGHT_PX = 28

const TickContainer = styled.span`
  position: absolute;
  width: calc(100% - 12px);
  height: 100%;
  left: 6px;
  display: flex;
  align-items: center;
  opacity: 1;

  &.enter {
    opacity: 0;
    transition: opacity 150ms linear;
  }

  &.enterActive {
    opacity: 1;
  }

  &.exit {
    opacity: 1;
    transition: opacity 150ms linear;
  }

  &.exitActive {
    opacity: 0;
  }
`

const ValueTick = styled.div`
  position: absolute;
  width: 2px;
  height: 2px;
  margin-left: -1px;
  border-radius: 50%;
  background-color: ${props => (props.filled ? darken(0.3, amberA400) : rgba(amberA400, 0.7))};
`

const Ticks = ({ show, value, min, max, step }) => {
  let container
  if (show) {
    const numSteps = (max - min) / step + 1
    const stepPercentage = (step / (max - min)) * 100
    const optionNum = (value - min) / step
    const elems = [
      // left is thumbWidth - 1, to avoid the tick being visible when the thumb is on that value
      <ValueTick key={0} filled={true} style={{ left: '-5px' }} />,
    ]
    for (let i = 1, p = stepPercentage; i < numSteps - 1; i++, p = i * stepPercentage) {
      elems.push(<ValueTick key={i} filled={i < optionNum} style={{ left: `${p}%` }} />)
    }
    elems.push(<ValueTick key={numSteps - 1} style={{ left: 'calc(100% + 5px)' }} />)

    container = (
      <CSSTransition classNames={transitionNames} timeout={150}>
        <TickContainer>{elems}</TickContainer>
      </CSSTransition>
    )
  }

  return <TransitionGroup>{container}</TransitionGroup>
}

const TrackRoot = styled.div`
  position: absolute;
  width: 100%;
  height: 4px;
  left: 0px;
  top: 54px;
  border-radius: 2px;
  background-color: ${props => (props.disabled ? rgba(colorTextFaint, 0.5) : rgba(amberA400, 0.3))};
`

// This wrapper is needed to make sure the border-radius doesn't get scaled with the filled track.
const FilledTrackWrapper = styled.div`
  position: absolute;
  left: 0;
  top: -1px;
  width: 100%;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
`

const FilledTrack = styled.div`
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: ${props => (props.disabled ? colorTextFaint : amberA400)};

  transform: scaleX(1);
  transform-origin: 0% 50%;
  transition: transform 150ms ${standardEasing};
  will-change: transform;
`

const Track = ({ disabled, showTicks, value, min, max, step, transitionDuration = 150 }) => {
  const scale = (value - min) / (max - min)
  const filledStyle = {
    transform: `scaleX(${scale})`,
    transitionDuration: `${transitionDuration}ms`,
  }

  return (
    <TrackRoot disabled={disabled}>
      <FilledTrackWrapper>
        <FilledTrack disabled={disabled} style={filledStyle} />
      </FilledTrackWrapper>
      <Ticks show={showTicks} value={value} min={min} max={max} step={step} />
    </TrackRoot>
  )
}

const Root = styled.div`
  height: 72px;
  position: relative;
  contain: layout style;

  ${props => (props.focused || props.disabled ? 'outline: none;' : '')}
`

const SliderLabel = styled.div`
  ${body1};
  position: absolute;
  top: 8px;
  left: 2px;

  color: ${colorTextSecondary};
  pointer-events: none;
`

const OverflowClip = styled.div`
  position: absolute;
  width: calc(100% + ${BALLOON_WIDTH_PX - THUMB_WIDTH_PX}px);
  height: 100%;
  top: 0;
  left: ${BALLOON_WIDTH_PX / -2 + THUMB_WIDTH_PX / 2}px;
  padding: 0 14px;

  overflow-x: hidden;
  overflow-y: visible;
  pointer-events: none;
`

const ThumbContainer = styled.div`
  position: relative;
  top: ${54 - THUMB_HEIGHT_PX / 2}px;
  width: 100%;
  pointer-events: none;
  will-change: transform;
  transition: transform 150ms ${standardEasing};
`

const Thumb = styled.div`
  position: absolute;
  width: ${THUMB_WIDTH_PX}px;
  height: ${THUMB_HEIGHT_PX}px;
  left: ${THUMB_WIDTH_PX / -2}px;
  top: 2px;

  background-color: ${props => (props.disabled ? colorTextFaint : amberA400)};
  border-radius: 50%;
  pointer-events: none;
  transition: background-color 200ms linear;
  z-index: 1;
`

const ClickableArea = styled.div`
  position: absolute;
  width: 100%;
  height: 32px;
  left: 0;
  bottom: 0;

  cursor: ${props => (props.disabled ? 'auto' : 'pointer')};
`

const Balloon = styled.div`
  position: absolute;
  width: ${BALLOON_WIDTH_PX}px;
  height: ${BALLOON_HEIGHT_PX}px;
  top: -42px;
  left: ${BALLOON_WIDTH_PX / -2}px;

  display: flex;
  align-items: center;
  justify-content: center;

  background-color: ${amberA400};
  border-radius: 50%;
  color: rgba(0, 0, 0, 0.87);
  pointer-events: none;
  text-align: center;
  transform-origin: 50% 150%;
  transition:
    transform 150ms ${standardEasing},
    background-color 200ms linear,
    color 200ms linear;
  will-change: transform, background-color, color;

  &::before {
    position: absolute;
    left: 0;
    top: 19px;

    border-radius: 16px;
    border-top: 16px solid ${amberA400};
    border-left: ${BALLOON_WIDTH_PX / 2}px solid transparent;
    border-right: ${BALLOON_WIDTH_PX / 2}px solid transparent;
    content: '';
    transition: border-top-color 250ms linear;
    will-change: border-top-color;
    z-index: 1;
  }

  &.enter {
    transform: scale(0, 0);
  }

  &.enterActive {
    transform: scale(1, 1);
  }

  &.exit {
    transform: scale(1, 1);
  }

  &.exitActive {
    transform: scale(0, 0);
  }
`

const BalloonText = styled.div`
  ${caption};
  font-weight: 600;
  line-height: ${BALLOON_HEIGHT_PX}px;
  z-index: 2;
`

class Slider extends React.Component {
  static propTypes = {
    min: PropTypes.number.isRequired,
    max: PropTypes.number.isRequired,
    value: PropTypes.number.isRequired,
    step: props => {
      if (typeof props.step !== 'number') {
        return new Error('`step` must be a number.')
      }
      if ((props.max - props.min) % props.step !== 0) {
        return new Error(
          'The range between `min` and `max` needs to be evenly divisible by `step`.',
        )
      }
      return null
    },
    disabled: PropTypes.bool,
    showTicks: PropTypes.bool,
    label: PropTypes.string,
    tabIndex: PropTypes.number,
    onChange: PropTypes.func,
  }

  static defaultProps = {
    step: 1,
    showTicks: true,
    tabIndex: 0,
  }

  state = {
    isFocused: false,
    isClicked: false,
    isDragging: false,
    keyDownCount: 0,
  }
  rootRef = React.createRef()
  trackAreaRef = React.createRef()
  balloonRef = React.createRef()
  _sliderDimensions = null
  _hasWindowListeners = false

  _addWindowListeners() {
    if (this._hasWindowListeners) return

    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('mouseup', this.onMouseUp)
    this._hasWindowListeners = true
  }

  _removeWindowListeners() {
    if (!this._hasWindowListeners) return

    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('mouseup', this.onMouseUp)
    this._hasWindowListeners = false
  }

  componentWillUnmount() {
    this._removeWindowListeners()
  }

  _renderBalloon() {
    if (!(this.state.isFocused || this.state.isClicked)) return null

    return (
      <CSSTransition classNames={transitionNames} timeout={300} nodeRef={this.balloonRef}>
        <Balloon ref={this.balloonRef}>
          <BalloonText>{this.props.value}</BalloonText>
        </Balloon>
      </CSSTransition>
    )
  }

  render() {
    const stepPercentage = (this.props.step / (this.props.max - this.props.min)) * 100

    const optionNum = (this.props.value - this.props.min) / this.props.step
    const thumbPosition = stepPercentage * optionNum

    const labelElement = this.props.label ? (
      <SliderLabel as='label' htmlFor={this.id}>
        {this.props.label}
      </SliderLabel>
    ) : null

    // Transition duration can make the animation look laggy if the user is quickly updating the
    // slider value, by e.g. holding down the left/right key or dragging the thumb with a mouse.
    // We're trying to account for that by shortening the transition duration when that happens.
    // These numbers were picked on a trial-and-error basis to fix the immediate issue of a laggy
    // slider; a deeper look into transition performance is needed to try to fix this in a more
    // deterministic way though.
    let transitionDuration
    if (this.state.isDragging) {
      transitionDuration = 0
    } else if (this.state.keyDownCount > 1 /* Means the user is holding down a left/right key */) {
      transitionDuration = 30
    } else {
      transitionDuration = 150
    }

    const thumbContainerStyle = {
      transform: `translateX(${thumbPosition}%)`,
      transitionDuration: `${transitionDuration}ms`,
    }

    return (
      <Root
        ref={this.rootRef}
        focused={this.state.isFocused}
        disabled={this.props.disabled}
        className={this.props.className}
        tabIndex={this.props.disabled ? -1 : this.props.tabIndex}
        onFocus={this.onFocus}
        onBlur={this.onBlur}
        onKeyDown={this.onKeyDown}
        onKeyUp={this.onKeyUp}>
        {labelElement}
        <Track
          min={this.props.min}
          max={this.props.max}
          step={this.props.step}
          value={this.props.value}
          disabled={this.props.disabled}
          showTicks={this.props.showTicks && this.state.isClicked}
          transitionDuration={transitionDuration}
        />
        <OverflowClip>
          <ThumbContainer style={thumbContainerStyle}>
            <Thumb disabled={this.props.disabled} />
            <TransitionGroup>{this._renderBalloon()}</TransitionGroup>
          </ThumbContainer>
        </OverflowClip>
        <ClickableArea
          ref={this.trackAreaRef}
          disabled={this.props.disabled}
          onMouseDown={this.onMouseDown}
        />
      </Root>
    )
  }

  focus() {
    if (this.props.disabled) {
      return
    }

    this.rootRef.current.focus()
  }

  blur() {
    if (this.props.disabled) {
      return
    }

    this.rootRef.current.blur()
  }

  onFocus = () => {
    if (this.props.disabled) {
      return
    }

    this.setState({ isFocused: true })
  }

  onBlur = () => {
    if (this.props.disabled) {
      return
    }

    this.setState({ isFocused: false })
  }

  onKeyDown = event => {
    if (this.props.disabled) {
      return
    }

    let handled = false
    if (event.keyCode === LEFT) {
      handled = true
      if (this.props.value !== this.props.min) {
        this.setState({ keyDownCount: this.state.keyDownCount + 1 })
        this.onChange(this.props.value - this.props.step)
      }
    } else if (event.keyCode === RIGHT) {
      handled = true
      if (this.props.value !== this.props.max) {
        this.setState({ keyDownCount: this.state.keyDownCount + 1 })
        this.onChange(this.props.value + this.props.step)
      }
    } else if (event.keyCode === HOME) {
      handled = true
      if (this.props.value !== this.props.min) {
        this.onChange(this.props.min)
      }
    } else if (event.keyCode === END) {
      handled = true
      if (this.props.value !== this.props.max) {
        this.onChange(this.props.max)
      }
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  onKeyUp = event => {
    if (this.props.disabled) {
      return
    }

    let handled = false
    if (event.keyCode === LEFT || event.keyCode === RIGHT) {
      handled = true
      this.setState({ keyDownCount: 0 })
    }

    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  minMaxValidator(value) {
    return Math.max(this.props.min, Math.min(this.props.max, value))
  }

  stepValidator(value) {
    const formattedValue =
      Math.round((value - this.props.min) / this.props.step) * this.props.step + this.props.min
    // Format to 3 digits after the decimal point; fixes issues when step is a decimal number
    return Math.round(formattedValue * 1000) / 1000
  }

  percentToValue(percent) {
    return this.props.min + percent * (this.props.max - this.props.min)
  }

  positionToPercent(x) {
    return Math.max(
      0,
      Math.min(1, (x - this._sliderDimensions.left) / this._sliderDimensions.width),
    )
  }

  getClosestValue(x) {
    const exactValue = this.percentToValue(this.positionToPercent(x))
    return this.minMaxValidator(this.stepValidator(exactValue))
  }

  onMouseDown = event => {
    if (this.props.disabled || !(event.buttons & MOUSE_LEFT)) {
      return
    }

    this._addWindowListeners()
    this._sliderDimensions = this.trackAreaRef.current.getBoundingClientRect()
    this.setState({ isClicked: true })
    const newValue = this.getClosestValue(event.clientX)
    if (newValue !== this.props.value) {
      this.onChange(newValue)
    }
  }

  onMouseMove = event => {
    if (this.props.disabled) {
      return
    }

    event.preventDefault()
    if (!this.state.isDragging) {
      this.setState({ isDragging: true })
    }
    const newValue = this.getClosestValue(event.clientX)
    if (newValue !== this.props.value) {
      this.onChange(newValue)
    }
  }

  onMouseUp = event => {
    if (this.props.disabled) {
      return
    }

    event.preventDefault()
    this._removeWindowListeners()
    this.setState({ isClicked: false, isDragging: false })
    const newValue = this.getClosestValue(event.clientX)
    if (newValue !== this.props.value) {
      this.onChange(newValue)
    }
  }

  onChange = newValue => {
    if (this.props.onChange) {
      this.props.onChange(newValue)
    }
  }
}

export default Slider
