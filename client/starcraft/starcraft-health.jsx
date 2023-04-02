import React from 'react'
import { connect } from 'react-redux'
import styled from 'styled-components'
import { STARCRAFT_DOWNLOAD_URL } from '../../common/constants'
import { closeDialog } from '../dialogs/action-creators'
import { DialogType } from '../dialogs/dialog-type'
import { Dialog } from '../material/dialog'
import { openSettingsDialog } from '../settings/action-creators'
import { openSnackbar } from '../snackbars/action-creators'
import { SubheadingOld } from '../styles/typography'
import {
  hasValidStarcraftPath,
  hasValidStarcraftVersion,
  isStarcraftHealthy,
} from './is-starcraft-healthy'
import { Trans, useTranslation } from 'react-i18next'

const HeaderText = styled(SubheadingOld)`
  margin-top: 0;
`

@connect(state => ({ starcraft: state.starcraft }))
export default class StarcraftHealthCheckupDialog extends React.Component {
  componentDidUpdate(prevProps) {
    if (isStarcraftHealthy(this.props)) {
      this.props.dispatch(
        openSnackbar({
          message: 'Your local installation is now free of problems.',
        }),
      )
      this.props.dispatch(closeDialog(DialogType.StarcraftHealth))
    }
  }

  renderInstallPathInfo() {
    if (hasValidStarcraftPath(this.props)) {
      return null
    }

    return (
      <p>
        <Trans i18nKey="starcraft.starcraftHealth.installationInvalid">
        Your StarCraft path setting does not point to a valid installation. Please correct the value
        in{' '}
        <a href='#' onClick={e => this.onSettingsClicked(e)}>
          Settings
        </a>
        . If you do not have the game installed, it can be easily downloaded from{' '}
        <span>
          <a href={STARCRAFT_DOWNLOAD_URL} target='_blank'>
            Blizzard's website
          </a>
        </span>
        . You may need to restart ShieldBattery after installation.
        </Trans>
      </p>
    )
  }

  renderStarcraftVersionInfo() {
    if (!hasValidStarcraftPath(this.props) || hasValidStarcraftVersion(this.props)) {
      return null
    }

    return (
      <div>
        <Trans i18nKey="starcraft.starcraftHealth.installationOutOfDate">
        <p>
          Your StarCraft installation is out of date. ShieldBattery supports installations of
          the latest Remastered version. Please install the{' '}
          <span>
            <a href={STARCRAFT_DOWNLOAD_URL} target='_blank'>
              latest version
            </a>
          </span>{' '}
          and restart ShieldBattery.
        </p>
        </Trans>
      </div>
    )
  }
  render() {
    const { t } = useTranslation()
    return (
      <Dialog
        title={'Installation problems detected'}
        onCancel={this.props.onCancel}
        showCloseButton={true}
        dialogRef={this.props.dialogRef}>
        <HeaderText as='p'>
        {t('starcraft.starcraftHealth.installationProblemsDescription', 'The following problems need to be corrected before you can play games on ShieldBattery:')}
        </HeaderText>
        {this.renderInstallPathInfo()}
        {this.renderStarcraftVersionInfo()}
      </Dialog>
    )
  }

  onSettingsClicked(e) {
    e.preventDefault()
    this.props.dispatch(openSettingsDialog())
  }
}
