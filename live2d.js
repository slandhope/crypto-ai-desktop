const { app, BrowserWindow } = require('electron')
const path = require('path')

let live2dWindow

function createLive2DWindow() {
  live2dWindow = new BrowserWindow({
    width: 300,
    height: 500,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: require('path').join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
  })

  live2dWindow.loadFile('waifu.html')
}

module.exports = { createLive2DWindow }