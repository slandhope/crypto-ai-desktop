const { contextBridge, ipcRenderer } = require('electron')

// Shared preload for login + companion windows (contextIsolation).
// Renderers must NOT get Node require('fs') / child_process.

function wrapIpc() {
  return {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
    on: (channel, listener) => {
      // Event is not structured-cloneable across contextBridge — pass null as first arg
      const handler = (_event, ...args) => listener(null, ...args)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    once: (channel, listener) => {
      ipcRenderer.once(channel, (_event, ...args) => listener(null, ...args))
    },
    removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
  }
}

const ipc = wrapIpc()

contextBridge.exposeInMainWorld('asuka', {
  ipc,
  // login helpers
  googleLogin: () => ipcRenderer.invoke('auth-google-login'),
  onAuthSuccess: (cb) => {
    const handler = (_e, user) => cb(user)
    ipcRenderer.on('auth-success', handler)
    return () => ipcRenderer.removeListener('auth-success', handler)
  },
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
})

// Back-compat aliases used by existing HTML/JS
contextBridge.exposeInMainWorld('ipcRenderer', ipc)
contextBridge.exposeInMainWorld('electronAPI', {
  openBrowser: (url) => ipcRenderer.send('open-browser', url),
  googleLogin: () => ipcRenderer.invoke('auth-google-login'),
  onAuthSuccess: (cb) => {
    const handler = (_e, user) => cb(user)
    ipcRenderer.on('auth-success', handler)
    return () => ipcRenderer.removeListener('auth-success', handler)
  },
})
