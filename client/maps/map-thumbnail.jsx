import React from 'react'
import PropTypes from 'prop-types'
import styled from 'styled-components'

import { fastOutSlowIn } from '../material/curve-constants'
import { colorTextSecondary } from '../styles/colors'
import { Subheading, singleLine } from '../styles/typography'

const Container = styled.div`
  position: relative;
  border-radius: 2px;
  overflow: hidden;
`

const MapImage = styled.img`
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: cover;
`

const Overlay = styled.div`
  position: absolute;
  width: 100%;
  height: ${props => (props.showMapName ? 'calc(100% - 48px)' : '100%')};
  display: flex;
  justify-content: center;
  align-items: center;
  background-color: ${props => {
    const opacity = props.isSelected ? '0.36' : '0'
    const style = `rgba(255, 229, 127, ${opacity})` /* amberA100 */

    return props.isSelected ? style + ' !important' : style
  }};
  transition: background-color 150ms ${fastOutSlowIn};

  &:hover {
    background-color: rgba(255, 229, 127, 0.12); /* amberA100 */
    cursor: pointer;
  }

  & > svg {
    width: 64px;
    height: 64px;
    opacity: 0.5;
  }
`

const NameContainer = styled.div`
  position: absolute;
  bottom: 0;
  width: 100%;
  height: 48px;
  padding: 0 16px;
  display: flex;
  align-items: center;
  background-color: rgba(0, 0, 0, 0.6);
`

const MapName = styled(Subheading)`
  color: ${colorTextSecondary};
  ${singleLine};
`

export default class MapThumbnail extends React.Component {
  static propTypes = {
    map: PropTypes.object.isRequired,
    showMapName: PropTypes.bool,
    isSelected: PropTypes.bool,
    selectedIcon: PropTypes.element,
    onClick: PropTypes.func,
  }

  render() {
    const { map, showMapName, isSelected, selectedIcon } = this.props

    return (
      <Container>
        <picture>
          <MapImage src={map.imageUrl} alt={map.name} />
        </picture>
        <Overlay isSelected={isSelected} showMapName={showMapName} onClick={this.onMapClick}>
          {isSelected && selectedIcon ? selectedIcon : null}
        </Overlay>
        {showMapName ? (
          <NameContainer>
            <MapName>{map.name}</MapName>
          </NameContainer>
        ) : null}
      </Container>
    )
  }

  onMapClick = event => {
    if (this.props.onClick) {
      this.props.onClick()
    }
  }
}
