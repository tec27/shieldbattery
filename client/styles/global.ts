import { createGlobalStyle } from 'styled-components'
import {
  amberA200,
  amberA400,
  background300,
  background700,
  CardLayer,
  colorTextFaint,
  colorTextPrimary,
  THEME_CSS,
} from './colors'
import { body1 } from './typography'

const GlobalStyle = createGlobalStyle`
  *, *::before, *::after {
    box-sizing: border-box;
    /**
      Generally allowing selection feels "un-app-like". For certain components, selection makes
      sense (e.g. predominantly text-based things, like chat boxes), but those are in the minority
      for us, so we make them specifically note themselves as exceptions to the rule.
    */
    user-select: none;
  }

  html {
    ${THEME_CSS};
    ${body1};

    font-family: Inter, sans-serif;
    font-optical-sizing: auto;
    font-weight: normal;
    color: var(--theme-on-surface);
    font-size: 14px;
    line-height: 1.42857;

    background-color: var(--theme-surface);
    --sb-color-background: var(--theme-surface);

    /** This will be overridden on the body styles in Electron */
    --sb-system-bar-height: 0px;

  }

  html, body, #app {
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
    -webkit-touch-callout: none;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    position: relative;
    overflow: hidden;
  }

  #app > div {
    width: 100%;
    height: calc(100% - var(--sb-system-bar-height, 0px));
  }

  [disabled] {
    color: ${colorTextFaint};
  }

  a:link, a:visited {
    color: ${amberA400};
    text-decoration: none;
  }

  a:hover, a:active {
    color: ${amberA200};
    text-decoration: underline;
  }

  svg {
    fill: currentColor;
  }

  input:-webkit-autofill {
    -webkit-box-shadow: 0 0 0px 1000px ${background700} inset !important;
    box-shadow: 0 0 0px 1000px ${background700} inset !important;
    -webkit-text-fill-color: ${colorTextPrimary} !important;
    caret-color: #fff !important;

    ${CardLayer} & {
      -webkit-box-shadow: 0 0 0px 1000px ${background300} inset !important;
      box-shadow: 0 0 0px 1000px ${background300} inset !important;
      -webkit-text-fill-color: ${colorTextPrimary} !important;
      caret-color: #fff !important;
    }
  }

  /** Style default scrollbar (at least in Webkit-based browsers) */
  *::-webkit-scrollbar {
    width: 16px;
  }

  *::-webkit-scrollbar-track {
    background-color: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
  }

  *::-webkit-scrollbar-thumb {
    width: 100%;
    border: 2px solid transparent;
    margin-left: auto;
    margin-right: auto;
    background-color: rgba(255, 255, 255, 0.12);
    background-clip: padding-box;
    /**
     * NOTE(tec27): This is more than the "usual" because it is inside of something that already
     * has border-radius, this makes it appear to match the outer radius
     */
    border-radius: 4px;

    &:hover, &:active {
      background-color: rgba(255, 255, 255, 0.16);
    }
  }

  *::-webkit-scrollbar-button:start:decrement,
  *::-webkit-scrollbar-button:end:increment {
    height: 0px;
  }
  /** End scrollbar styling */
`

export default GlobalStyle
