import { Immutable } from 'immer'
import React, { useCallback, useImperativeHandle, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MatchmakingMapPool,
  MatchmakingPreferences1v1,
  MatchmakingType,
} from '../../common/matchmaking'
import { AssignedRaceChar, RaceChar } from '../../common/races'
import { SbUserId } from '../../common/users/sb-user'
import { useSelfUser } from '../auth/auth-utils'
import { useForm } from '../forms/form-hook'
import { RacePickerSize } from '../lobbies/race-picker'
import { CheckBox } from '../material/check-box'
import { LoadingDotsArea } from '../progress/dots'
import { useAppDispatch, useAppSelector } from '../redux-hooks'
import { updateMatchmakingPreferences } from './action-creators'
import {
  DescriptionText,
  FindMatchContentsProps,
  FindMatchFormRef,
  MapSelectionsHeader,
  MapVetoesControl,
  OutdatedIndicator,
  SectionTitle,
  StyledRaceSelect,
  VetoDescriptionText,
} from './find-match-forms'

interface Model1v1 {
  race: RaceChar
  mapSelections: string[]
  useAlternateRace: boolean
  alternateRace: AssignedRaceChar
}

interface Form1v1Props {
  disabled: boolean
  model: Model1v1
  mapPool?: Immutable<MatchmakingMapPool>
  mapPoolOutdated: boolean
  onChange: (model: Model1v1) => void
  onSubmit: (model: Model1v1) => void
}

const Form1v1 = React.forwardRef<FindMatchFormRef, Form1v1Props>(
  ({ disabled, model, mapPoolOutdated, mapPool, onChange, onSubmit }, ref) => {
    const { t } = useTranslation()
    const {
      onSubmit: handleSubmit,
      bindCheckable,
      bindCustom,
      getInputValue,
    } = useForm<Model1v1>(model, {}, { onChange, onSubmit })

    useImperativeHandle(ref, () => ({
      submit: handleSubmit,
    }))

    const race = getInputValue('race')
    const useAlternateRace = race !== 'r' ? getInputValue('useAlternateRace') : false
    const hiddenAlternateRaces = race !== 'r' ? [race] : []

    return (
      <form noValidate={true} onSubmit={handleSubmit}>
        <SectionTitle>{t('matchmaking.findMatch.race', 'Race')}</SectionTitle>
        <StyledRaceSelect
          {...bindCustom('race')}
          size={RacePickerSize.Large}
          allowInteraction={!disabled}
        />
        {race !== 'r' ? (
          <CheckBox
            {...bindCheckable('useAlternateRace')}
            label={t(
              'matchmaking.findMatch.useAlternateRace',
              'Use alternate race to avoid mirror matchups',
            )}
            disabled={disabled}
          />
        ) : null}
        {useAlternateRace ? (
          <>
            <SectionTitle>
              {t('matchmaking.findMatch.alternateRace', 'Alternate race')}
            </SectionTitle>
            <DescriptionText>
              {t(
                'matchmaking.findMatch.description',
                'Select a race to be used whenever your opponent has selected the same primary ' +
                  'race.',
              )}
            </DescriptionText>
            <StyledRaceSelect
              {...bindCustom('alternateRace')}
              hiddenRaces={hiddenAlternateRaces}
              size={RacePickerSize.Large}
              allowRandom={false}
              allowInteraction={!disabled}
            />
          </>
        ) : null}
        {mapPool ? (
          <>
            <MapSelectionsHeader>
              <SectionTitle>{t('matchmaking.findMatch.mapPool', 'Map pool')}</SectionTitle>
              {mapPoolOutdated ? (
                <OutdatedIndicator>
                  {t('matchmaking.findMatch.updated', 'Updated')}
                </OutdatedIndicator>
              ) : null}
            </MapSelectionsHeader>

            <VetoDescriptionText
              maxVetoCount={mapPool.maxVetoCount}
              mapPoolSize={mapPool.maps.length}
              numberOfPlayers={2}
            />
            <MapVetoesControl
              {...bindCustom('mapSelections')}
              mapPool={mapPool}
              disabled={disabled}
            />
          </>
        ) : (
          <LoadingDotsArea />
        )}
      </form>
    )
  },
)

function model1v1ToPrefs(model: Model1v1, userId: SbUserId, mapPoolId: number) {
  return {
    userId,
    matchmakingType: MatchmakingType.Match1v1 as const,
    race: model.race,
    mapPoolId,
    mapSelections: model.mapSelections,
    data: {
      useAlternateRace: model.race !== 'r' ? model.useAlternateRace : false,
      alternateRace: model.alternateRace,
    },
  }
}

export function Contents1v1({ formRef, onSubmit, disabled }: FindMatchContentsProps) {
  const dispatch = useAppDispatch()
  const selfUser = useSelfUser()!
  const prefs: Immutable<MatchmakingPreferences1v1> | Record<string, never> =
    useAppSelector(
      s =>
        s.matchmakingPreferences.byType.get(MatchmakingType.Match1v1)?.preferences as
          | Immutable<MatchmakingPreferences1v1>
          | Record<string, never>
          | undefined,
    ) ?? {}
  const mapPoolOutdated = useAppSelector(
    s => s.matchmakingPreferences.byType.get(MatchmakingType.Match1v1)?.mapPoolOutdated ?? false,
  )
  const mapPool = useAppSelector(s => s.mapPools.byType.get(MatchmakingType.Match1v1))
  const mapSelections = useMemo(
    () => (prefs.mapSelections ?? []).filter(id => !mapPool || mapPool.maps.includes(id)),
    [prefs.mapSelections, mapPool],
  )

  const selfId = selfUser.id
  const mapPoolId = mapPool?.id ?? 0
  const onPrefsChanged = useCallback(
    (model: Model1v1) => {
      if (disabled) {
        return
      }

      dispatch(
        updateMatchmakingPreferences(
          MatchmakingType.Match1v1,
          model1v1ToPrefs(model, selfId, mapPoolId),
        ),
      )
    },
    [dispatch, mapPoolId, selfId, disabled],
  )
  const onFormSubmit = useCallback(
    (model: Model1v1) => {
      if (disabled) {
        return
      }

      onSubmit(model1v1ToPrefs(model, selfId, mapPoolId))
    },
    [disabled, mapPoolId, onSubmit, selfId],
  )

  return (
    <Form1v1
      ref={formRef}
      disabled={disabled}
      model={{
        race: prefs.race ?? 'r',
        useAlternateRace: prefs.data?.useAlternateRace ?? false,
        alternateRace: prefs.data?.alternateRace ?? 'z',
        mapSelections,
      }}
      onChange={onPrefsChanged}
      onSubmit={onFormSubmit}
      mapPoolOutdated={mapPoolOutdated}
      mapPool={mapPool}
    />
  )
}
