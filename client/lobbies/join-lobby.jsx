import PropTypes from 'prop-types'
import React from 'react'
import { withTranslation } from 'react-i18next'
import { connect } from 'react-redux'
import styled from 'styled-components'
import { gameTypeToLabel } from '../../common/games/configuration'
import { MaterialIcon } from '../icons/material/material-icon'
import { MapThumbnail } from '../maps/map-thumbnail'
import { RaisedButton } from '../material/button'
import siteSocket from '../network/site-socket'
import { colorDividers } from '../styles/colors'
import { FlexSpacer } from '../styles/flex-spacer'
import { Body1, Headline5, Headline6, Subtitle1, Subtitle2 } from '../styles/typography'
import { joinLobby, navigateToLobby } from './action-creators'

const ListEntryRoot = styled.div`
  width: 100%;
  padding-left: 16px;
  padding-right: 16px;
  padding-bottom: 7px;

  display: flex;
  align-items: center;

  &:hover {
    cursor: pointer;
    background-color: rgba(255, 255, 255, 0.08);
  }

  &:first-child {
    padding-top: 8px;
  }

  &:last-child {
    padding-bottom: 8px;
  }

  & + & {
    padding-top: 8px;
    border-top: 1px solid ${colorDividers};
  }
`

const Info = styled.div`
  display: flex;
  flex-direction: column;
  flex-grow: 1;
`

const MapPreview = styled.div`
  width: 128px;
  height: 128px;
  position: relative;

  flex-shrink: 0;
  margin-left: 8px;
`

@withTranslation()
class ListEntry extends React.Component {
  static propTypes = {
    lobby: PropTypes.object.isRequired,
    onClick: PropTypes.func.isRequired,
  }

  shouldComponentUpdate(nextProps) {
    return nextProps.lobby !== this.props.lobby || nextProps.onClick !== this.props.onClick
  }

  render() {
    const { lobby, onClick, t } = this.props

    return (
      <ListEntryRoot onClick={() => onClick(lobby)}>
        <Info>
          <Headline6>{lobby.name}</Headline6>
          <Subtitle2>{lobby.host.name}</Subtitle2>
          <Body1>{gameTypeToLabel(lobby.gameType, t)}</Body1>
          <Body1>
            {t('lobbies.joinLobby.openSlotCount', {
              defaultValue: '{{count}} slots open',
              count: lobby.openSlotCount,
            })}
          </Body1>
        </Info>
        <MapPreview>
          <MapThumbnail map={lobby.map} showMapName={true} canHover={false} />
        </MapPreview>
      </ListEntryRoot>
    )
  }
}

const Container = styled.div`
  display: flex;
  flex-direction: column;
`

const TitleBar = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  margin: 16px 24px;
`

const Contents = styled.div`
  position: relative;
  flex-grow: 1;
`

const ContentsBody = styled.div`
  padding: 12px 24px;
`

@withTranslation()
@connect(state => ({ lobbyList: state.lobbyList }))
export default class JoinLobby extends React.Component {
  constructor(props) {
    super(props)
    this._handleLobbyClick = this.onLobbyClick.bind(this)
  }

  componentDidMount() {
    siteSocket.invoke('/lobbies/subscribe')
  }

  componentWillUnmount() {
    siteSocket.invoke('/lobbies/unsubscribe')
  }

  renderList() {
    const { t } = this.props
    const { byName, list } = this.props.lobbyList
    if (!list.size) {
      return (
        <div>
          <Subtitle1>
            {t('lobbies.joinLobby.noActiveLobbies', 'There are no active lobbies')}
          </Subtitle1>
        </div>
      )
    }

    const openLobbies = list.filter(name => byName.get(name).openSlotCount > 0)
    return (
      <div>
        {!openLobbies.isEmpty() ? (
          openLobbies.map(name => (
            <ListEntry key={name} lobby={byName.get(name)} onClick={this._handleLobbyClick} />
          ))
        ) : (
          <Subtitle1>{t('lobbies.joinLobby.noOpenLobbies', 'There are no open lobbies')}</Subtitle1>
        )}
      </div>
    )
  }

  render() {
    const { t } = this.props
    return (
      <Container>
        <TitleBar>
          <Headline5>{t('lobbies.joinLobby.title', 'Join Lobby')}</Headline5>
          <FlexSpacer />
          <RaisedButton
            label={t('lobbies.createLobby.title', 'Create lobby')}
            iconStart={<MaterialIcon icon='add' />}
            onClick={this.props.onNavigateToCreate}
          />
        </TitleBar>
        <Contents>
          <ContentsBody>{this.renderList()}</ContentsBody>
        </Contents>
      </Container>
    )
  }

  onLobbyClick(lobby) {
    this.props.dispatch(joinLobby(lobby.name))
    this.props.dispatch(closeOverlay())
    navigateToLobby(lobby.name)
  }
}
