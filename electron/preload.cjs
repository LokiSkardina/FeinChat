const { contextBridge, ipcRenderer } = require('electron');

const request = (command, args) => ipcRenderer.invoke('feinchat:request', command, args);

contextBridge.exposeInMainWorld('feinchat', {
  read: () => request('read'),
  setTheme: (theme) => request('appearance:theme', { theme }),
  readChat: (chatId) => request('chat:read', { chatId }),
  createChat: () => request('chat:create'),
  selectChat: (chatId) => request('chat:select', { chatId }),
  renameChat: (chatId, name) => request('chat:rename', { chatId, name }),
  pinChat: (chatId, pinned) => request('chat:pin', { chatId, pinned }),
  deleteChat: (chatId, confirmed) => request('chat:delete', { chatId, confirmed }),
  saveProvider: (provider) => request('provider:save', { provider }),
  setDefaultProvider: (providerId) => request('provider:default', { providerId }),
  applyModel: (chatId, providerId, model, parameters) => request('chat:model', { chatId, providerId, model, parameters }),
  editMessage: (args) => request('message:edit', args),
  deleteMessage: (args) => request('message:delete', args),
  copy: (content) => request('message:copy', { content }),
  openLink: (url) => request('link:open', { url }),
  start: (args) => request('generation:start', args),
  stop: (chatId, messageId) => request('generation:stop', { chatId, messageId }),
  onGeneration: (callback) => {
    const listener = (_event, update) => callback(update);
    ipcRenderer.on('feinchat:generation', listener);
    return () => ipcRenderer.removeListener('feinchat:generation', listener);
  },
});
