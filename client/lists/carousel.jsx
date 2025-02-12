import PropTypes from 'prop-types'
import React from 'react'
import { withTranslation } from 'react-i18next'
import styled from 'styled-components'
import WindowListener from '../dom/window-listener'
import { MaterialIcon } from '../icons/material/material-icon'
import { IconButton, Label } from '../material/button'
import { standardEasing } from '../material/curve-constants'
import { colorTextSecondary } from '../styles/colors'
import InfiniteScrollList from './infinite-scroll-list'

const BUTTON_WIDTH = 64
const LOADER_WIDTH = 98
const SCROLL_LEEWAY = 128

const CarouselContainer = styled.div`
  display: flex;
  align-items: center;
`

const CarouselContentMask = styled.div`
  display: flex;
  flex-grow: 1;
  overflow: hidden;

  ${props => {
    const leftGradient = 'transparent 0%, #000 16%'
    const rightGradient = '#000 84%, transparent 100%'
    const gradients = []

    if (props.showLeft) {
      gradients.push(leftGradient)
    }
    if (props.showRight) {
      gradients.push(rightGradient)
    }

    return gradients.length > 0
      ? `-webkit-mask-image: linear-gradient(90deg, ${gradients.join(', ')})`
      : ''
  }};
`

const CarouselContent = styled.div`
  display: flex;
  flex-shrink: 0;
  transition: transform 250ms ${standardEasing};
`

const CarouselButton = styled(IconButton)`
  flex-shrink: 0;
  margin: 0 8px;

  ${Label} {
    color: ${colorTextSecondary};
  }
`

@withTranslation('global', { withRef: true })
export default class Carousel extends React.Component {
  static propTypes = {
    isLoading: PropTypes.bool,
    // Whether the carousel has more items that could be requested
    hasMoreItems: PropTypes.bool,
    onLoadMoreData: PropTypes.func,
  }

  state = {
    translateWidth: 0,
    carouselWidth: 0,
    contentWidth: 0,
    stepWidth: 0,
    hasPrevItems: false,
    hasNextItems: false,
  }

  _carouselRef = React.createRef()
  _contentRef = React.createRef()
  _animationId = null
  _refreshToken = 0

  componentDidMount() {
    this._calcCarouselWidth()
  }

  componentDidUpdate(prevProps, prevState) {
    const prevCount = React.Children.count(prevProps.children)
    const currCount = React.Children.count(this.props.children)

    if (prevCount !== currCount || prevState.translateWidth !== this.state.translateWidth) {
      this._calcCarouselWidth()
    }
  }

  componentWillUnmount() {
    window.cancelAnimationFrame(this._animationId)
  }

  _calcCarouselWidth = () => {
    const { translateWidth } = this.state
    // This is the width of currently visible items
    let carouselWidth = this._carouselRef.current.getBoundingClientRect().width
    // This is the width of all items in total
    const contentWidth = this._contentRef.current.getBoundingClientRect().width

    const hasPrevItems = translateWidth < 0
    const adjustment = hasPrevItems ? BUTTON_WIDTH : 0
    const hasNextItems = contentWidth - carouselWidth + adjustment > Math.abs(translateWidth)

    if (hasPrevItems && hasNextItems) {
      carouselWidth = carouselWidth - BUTTON_WIDTH * 2 // both prev and next buttons are visible
    } else if (hasPrevItems || hasNextItems) {
      carouselWidth = carouselWidth - BUTTON_WIDTH // only one of the buttons is visible
    }

    // Scroll 60% of the currently visible items
    const stepWidth = carouselWidth * 0.6

    this.setState({ carouselWidth, contentWidth, stepWidth, hasPrevItems, hasNextItems })
  }

  reset() {
    this._refreshToken++
    this.setState({ translateWidth: 0 })
  }

  render() {
    const { isLoading, hasMoreItems, onLoadMoreData, t } = this.props
    const { translateWidth, hasPrevItems, hasNextItems } = this.state

    const contentStyle = { transform: `translateX(${translateWidth}px)` }
    const showPrevButton = hasPrevItems
    const showNextButton = hasNextItems && !isLoading

    return (
      <CarouselContainer ref={this._carouselRef} className={this.props.className}>
        <WindowListener event='resize' listener={this._calcCarouselWidth} />
        {showPrevButton ? (
          <CarouselButton
            icon={<MaterialIcon icon='chevron_left' />}
            title={t('common.actions.previous', 'Previous')}
            onClick={this.onPrev}
          />
        ) : null}
        <CarouselContentMask showLeft={showPrevButton} showRight={showNextButton}>
          <CarouselContent ref={this._contentRef} style={contentStyle}>
            <InfiniteScrollList
              nextLoadingEnabled={true}
              isLoadingNext={isLoading}
              hasNextData={hasMoreItems}
              refreshToken={this._refreshToken}
              onLoadNextData={onLoadMoreData}>
              {this.props.children}
            </InfiniteScrollList>
          </CarouselContent>
        </CarouselContentMask>
        {showNextButton ? (
          <CarouselButton
            icon={<MaterialIcon icon='chevron_right' />}
            title={t('common.actions.next', 'Next')}
            onClick={this.onNext}
          />
        ) : null}
      </CarouselContainer>
    )
  }

  animatePosition = (currentWidth, delta) => {
    const translateWidth = currentWidth + delta

    this.setState({ translateWidth })
  }

  onPrev = () => {
    const { translateWidth, stepWidth } = this.state

    const delta =
      translateWidth + stepWidth + SCROLL_LEEWAY > 0 ? Math.abs(translateWidth) : stepWidth

    this._animationId = window.requestAnimationFrame(() =>
      this.animatePosition(translateWidth, delta),
    )
  }

  onNext = () => {
    const { translateWidth, carouselWidth, contentWidth, stepWidth, hasPrevItems, hasNextItems } =
      this.state

    // When we reach the end of the list, we need to adjust the translate width a bit, depending on
    // whether we have more items to load (in which case the loader will be shown), or if we've
    // reached the last page, then nothing will be shown
    let adjustment = 0
    if (this.props.hasMoreItems && !this.props.isLoading) {
      adjustment = BUTTON_WIDTH - LOADER_WIDTH
    } else if (hasPrevItems && hasNextItems) {
      adjustment = BUTTON_WIDTH
    }
    const delta =
      Math.abs(translateWidth) + stepWidth + carouselWidth + SCROLL_LEEWAY > contentWidth
        ? contentWidth - Math.abs(translateWidth) - carouselWidth - adjustment
        : stepWidth

    this._animationId = window.requestAnimationFrame(() =>
      this.animatePosition(translateWidth, -delta),
    )
  }
}
