import { constructURL, download, DownloadOptions } from 'google-fonts-helper'
import path from 'path'

/**
 * A URL for all the Google fonts used in the app. This will be used at build time to download the
 * necessary fonts for self-hosting.
 */
const GOOGLE_FONTS_URL = constructURL({
  families: {
    Inter: {
      wght: [400, 500],
    },
    'Sofia Sans': {
      wght: [400, 600, 700],
    },
  },
  display: 'swap',
})

// NOTE(tec27): We need a separate url just for the icon font, as we can't set a separate
// font-display setting otherwise
// TODO(tec27): Move to constructURL API once
// https://github.com/datalogix/google-fonts-helper/issues/72 is fixed
const ICON_FONT_URL =
  'https://fonts.googleapis.com/css2' +
  '?family=Material+Symbols+Outlined:opsz,FILL,GRAD@20..48,0..1,-25..0' +
  '&display=block'

async function doDownload() {
  if (!GOOGLE_FONTS_URL) {
    throw new Error('Constructing fonts URL failed')
  }
  if (!ICON_FONT_URL) {
    throw new Error('Constructing icon font URL failed')
  }

  const headers = [
    [
      'user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ],
  ] satisfies DownloadOptions['headers']

  const electronDownloader = download(GOOGLE_FONTS_URL, {
    base64: false,
    overwriting: true,
    outputDir: path.join(__dirname, 'app', 'assets', 'fonts'),
    stylePath: 'fonts.css',
    fontsDir: '',
    fontsPath: '.',
    headers,
  })
  electronDownloader.hook('download-font:before', font => {
    console.log(`Processing ${font.inputFont} -> ${font.outputFont}`)
  })
  const electronIconDownloader = download(ICON_FONT_URL, {
    base64: false,
    overwriting: false,
    outputDir: path.join(__dirname, 'app', 'assets', 'fonts'),
    stylePath: 'icons.css',
    fontsDir: '',
    fontsPath: '.',
  })
  electronIconDownloader.hook('download-font:before', font => {
    console.log(`Processing ${font.inputFont} -> ${font.outputFont}`)
  })

  console.log('Downloading fonts for Electron...')
  await electronDownloader.execute()
  await electronIconDownloader.execute()
  console.log('Done!')

  const webDownloader = download(GOOGLE_FONTS_URL, {
    base64: false,
    overwriting: true,
    outputDir: path.join(__dirname, 'server', 'public', 'fonts'),
    stylePath: 'fonts.css',
    fontsDir: '',
    fontsPath: '.',
  })
  webDownloader.hook('download-font:before', font => {
    console.log(`Processing ${font.inputFont} -> ${font.outputFont}`)
  })
  const webIconDownloader = download(ICON_FONT_URL, {
    base64: false,
    overwriting: false,
    outputDir: path.join(__dirname, 'server', 'public', 'fonts'),
    stylePath: 'icons.css',
    fontsDir: '',
    fontsPath: '.',
  })
  webIconDownloader.hook('download-font:before', font => {
    console.log(`Processing ${font.inputFont} -> ${font.outputFont}`)
  })

  console.log('Downloading fonts for Web...')
  await webDownloader.execute()
  await webIconDownloader.execute()
  console.log('Done!')
}

doDownload().then(
  () => {
    console.log('All done!')
  },
  err => {
    console.error(err)
  },
)
