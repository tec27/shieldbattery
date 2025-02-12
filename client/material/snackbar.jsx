import PropTypes from 'prop-types'
import React from 'react'
import styled from 'styled-components'
import { background700 } from '../styles/colors'
import { TextButton } from './button'
import { accelerateEasing, decelerateEasing, standardEasing } from './curve-constants'
import { shadow6dp } from './shadows'
import { zIndexSnackbar } from './zindex'

const MessageContainer = styled.div`
  line-height: 20px;
  padding: 14px 24px;
  min-height: 48px;
  overflow: hidden;
`

const ActionButton = styled(TextButton)`
  flex-shrink: 0;
  margin-left: 24px;
  margin-right: 16px;
`

const Container = styled.div`
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  text-align: center;
  z-index: ${zIndexSnackbar};

  &.enter {
    transform-origin: bottom;
    transform: translate3d(0, 100%, 0);
  }

  &.enterActive {
    transition: transform 350ms ${decelerateEasing};
    transform: translate3d(0, 0, 0);
  }

  &.exit {
    transform-origin: top;
    transform: translate3d(0, 0, 0);
  }

  &.exitActive {
    transition: transform 250ms ${accelerateEasing};
    transform: translate3d(0, 100%, 0);
  }

  &.enter ${MessageContainer}, &.enter ${ActionButton} {
    opacity: 0.4;
  }

  &.enterActive ${MessageContainer}, &.enterActive ${ActionButton} {
    opacity: 1;
    transition: opacity 450ms ${standardEasing} 50ms;
  }
`

const Content = styled.div`
  ${shadow6dp};
  display: inline-flex;
  justify-content: space-between;
  align-items: center;
  overflow: hidden;
  width: auto;
  min-width: 288px;
  max-width: 568px;
  height: auto;
  text-align: left;
  border-radius: 2px;
  background-color: ${background700};
`

class Snackbar extends React.Component {
  static propTypes = {
    id: PropTypes.string.isRequired,
    message: PropTypes.string.isRequired,
    actionLabel: PropTypes.string,
    action: props => {
      if (props.actionLabel && !props.action) {
        return new Error('`action` is required when `actionLabel` is supplied')
      }
      if (props.action && typeof props.action !== 'function') {
        return new Error('`action` needs to be a function')
      }
      return null
    },
    testName: PropTypes.string,
  }

  constructor(props) {
    super(props)
    this._handleActionClick = this.onActionClick.bind(this)
  }

  render() {
    const actionButton = this.props.actionLabel ? (
      <ActionButton
        label={this.props.actionLabel}
        color='accent'
        onClick={this._handleActionClick}
      />
    ) : null
    return (
      <Container>
        <Content>
          <MessageContainer data-test={this.props.testName}>{this.props.message}</MessageContainer>
          {actionButton}
        </Content>
      </Container>
    )
  }

  onActionClick() {
    if (this.props.action) {
      this.props.action(this.props.id)
    }
  }
}

export default Snackbar
