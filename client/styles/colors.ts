import styled, { css } from 'styled-components'
import { assertUnreachable } from '../../common/assert-unreachable'
import { RaceChar } from '../../common/races'

export const blue10 = '#121421'
export const blue20 = '#191f38'
export const blue30 = '#1b274f'
export const blue40 = '#1e3a81'
export const blue50 = '#1a51bf'
export const blue60 = '#1a69ea'
export const blue70 = '#1e7dfc'
export const blue80 = '#3392fb'
export const blue90 = '#67b5fc'
export const blue95 = '#c5e5fd'
export const blue99 = '#e0f3fe'

export const amber10 = '#2e1e0c'
export const amber20 = '#613d0f'
export const amber30 = '#945c0e'
export const amber40 = '#c27c0a'
export const amber50 = '#e79907'
export const amber60 = '#f9b100'
export const amber70 = '#ffc400'
export const amber80 = '#ffd53f'
export const amber90 = '#ffe378'
export const amber95 = '#ffeb9e'
export const amber99 = '#fff3c5'

export const greyBlue10 = '#111a24'
export const greyBlue20 = '#141e2a'
export const greyBlue30 = '#1c2837'
export const greyBlue40 = '#223143'
export const greyBlue50 = '#2d3f57'
export const greyBlue60 = '#445979'
export const greyBlue70 = '#7b94bb'
export const greyBlue80 = '#a3b9de'
export const greyBlue90 = '#c0d2f3'
export const greyBlue95 = '#d2dff8'
export const greyBlue99 = '#e7efff'

export const grey10 = '#1b1e22'
export const grey20 = '#252a31'
export const grey30 = '#353d45'
export const grey40 = '#505762'
export const grey50 = '#68717c'
export const grey60 = '#9198a1'
export const grey70 = '#b2bbc7'
export const grey80 = '#d3dae4'
export const grey90 = '#e0e7f0'
export const grey95 = '#ebf1fa'
export const grey99 = '#f5fbfe'

export const colorElevationLowest = '#101523'
export const colorElevationLow = '#151c2e'
export const colorElevationNormal = '#162036'
export const colorElevationHigh = '#192643'
export const colorElevationHighest = '#1d3258'

export const THEME_CSS = css`
  --color-blue10: ${blue10};
  --color-blue20: ${blue20};
  --color-blue30: ${blue30};
  --color-blue40: ${blue40};
  --color-blue50: ${blue50};
  --color-blue60: ${blue60};
  --color-blue70: ${blue70};
  --color-blue80: ${blue80};
  --color-blue90: ${blue90};
  --color-blue95: ${blue95};
  --color-blue99: ${blue99};

  --color-amber10: ${amber10};
  --color-amber20: ${amber20};
  --color-amber30: ${amber30};
  --color-amber40: ${amber40};
  --color-amber50: ${amber50};
  --color-amber60: ${amber60};
  --color-amber70: ${amber70};
  --color-amber80: ${amber80};
  --color-amber90: ${amber90};
  --color-amber95: ${amber95};
  --color-amber99: ${amber99};

  --color-grey-blue10: ${greyBlue10};
  --color-grey-blue20: ${greyBlue20};
  --color-grey-blue30: ${greyBlue30};
  --color-grey-blue40: ${greyBlue40};
  --color-grey-blue50: ${greyBlue50};
  --color-grey-blue60: ${greyBlue60};
  --color-grey-blue70: ${greyBlue70};
  --color-grey-blue80: ${greyBlue80};
  --color-grey-blue90: ${greyBlue90};
  --color-grey-blue95: ${greyBlue95};
  --color-grey-blue99: ${greyBlue99};

  --color-grey10: ${grey10};
  --color-grey20: ${grey20};
  --color-grey30: ${grey30};
  --color-grey40: ${grey40};
  --color-grey50: ${grey50};
  --color-grey60: ${grey60};
  --color-grey70: ${grey70};
  --color-grey80: ${grey80};
  --color-grey90: ${grey90};
  --color-grey95: ${grey95};
  --color-grey99: ${grey99};

  --color-elevation-lowest: ${colorElevationLowest};
  --color-elevation-low: ${colorElevationLow};
  --color-elevation-normal: ${colorElevationNormal};
  --color-elevation-high: ${colorElevationHigh};
  --color-elevation-highest: ${colorElevationHighest};

  --theme-primary: var(--color-blue80);
  --theme-on-primary: var(--color-blue10);
  --theme-primary-container: var(--color-blue30);
  --theme-on-primary-container: var(--color-blue90);

  --theme-amber: var(--color-amber70);
  --theme-amber-container: var(--color-amber90);
  --theme-on-amber-container: var(--color-amber10);

  --theme-surface: var(--color-blue10);
  --theme-on-surface: var(--color-grey99);
  --theme-on-surface-variant: var(--color-blue95);

  --theme-outline: var(--color-grey-blue60);
  --theme-outline-variant: var(--color-grey-blue40);
`

// FIXME: delete these
/* Primary color */
export const blue100 = '#bbdefb'
export const blue200 = '#90caf9'
export const blue300 = '#64b5f6'
export const blue400 = '#42a5f5'
export const blue500 = '#2196f3'
export const blue600 = '#1e88e5'
export const blue700 = '#1976d2'
export const blue800 = '#1565c0'
export const blue900 = '#0d47a1'

// FIXME: delete these
/* Accent color */
export const amberA100 = '#ffe57f'
export const amberA200 = '#ffd740'
export const amberA400 = '#ffc400'
export const amberA700 = '#ffab00'

/** Colors used for backgrounds (a muted grey-blue palette) */
export const background50 = '#7B97BA'
export const background100 = '#6584AA'
export const background200 = '#577598'
export const background300 = '#466180'
export const background400 = '#30455F'
export const background500 = '#243951'
export const background600 = '#1D2F44'
export const background700 = '#142539'
export const background800 = '#0E1B2A'
export const background900 = '#091320'

/** Background colors used for accenting particularly prominent UI. */
export const backgroundSaturatedLight = '#02498C'
export const backgroundSaturatedDark = '#034078'

export const alphaDividers = 0.12
export const alphaDisabled = 0.5

export const colorText = '#ffffff'

export const colorDividers = `rgba(255, 255, 255, ${alphaDividers})`
export const colorTextFaint = '#8998a9'
export const colorTextSecondary = '#cdddee'
export const colorTextPrimary = '#ffffff'
export const colorTextInvert = 'rgba(0, 0, 0, 0.87)'
export const colorTextInvertSecondary = 'rgba(0, 0, 0, 0.6)'

export const colorBackground = background800
export const colorError = '#ff6e6e'
export const colorSuccess = '#66bb6a'

/** Color used to indicate something positive (e.g. winning). */
export const colorPositive = '#69f0ae'
/** Color used to indicate something negative (e.g. losing). */
export const colorNegative = '#e66060'

export const colorZerg = '#c1a3f5'
export const colorProtoss = '#ffe57f'
export const colorTerran = '#89bbf5'
export const colorRandom = '#f5a63d'

export function getRaceColor(race: RaceChar) {
  switch (race) {
    case 'z':
      return colorZerg
    case 'p':
      return colorProtoss
    case 't':
      return colorTerran
    case 'r':
      return colorRandom
    default:
      return assertUnreachable(race)
  }
}

export const dialogScrim = background900

export const CardLayer = styled.div`
  background-color: ${background400};
  --sb-color-background: ${background400};
`
