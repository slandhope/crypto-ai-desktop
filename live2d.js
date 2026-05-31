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
      nodeIntegration: true,
      contextIsolation: false,
    },
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
  })

  live2dWindow.loadFile('waifu.html')
}

module.exports = { createLive2DWindow }