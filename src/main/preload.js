const { contextBridge, ipcRenderer } = require('electron');

const operations = ['snapshot', 'loadAppearance', 'saveAppearance', 'chooseWorkspace', 'chooseFiles', 'chooseAttachments', 'listFiles', 'openWorkspaceFile',
  'readFile', 'readSheet', 'pdfResource', 'saveFile', 'createArtifact', 'openExternal', 'revealData',
  'sessionFamily', 'reviewWorkspace', 'reviewRead', 'reviewPatch', 'reviewApply', 'reviewUndo', 'projectCheck', 'saveProjectCheck', 'runProjectCheck',
  'editorLanguageSync', 'editorLanguageClose', 'editorDefinition',
  'createSession', 'transcript', 'runRecord', 'retryRun', 'catalog', 'prompt', 'steer', 'removeQueued', 'resumeQueue', 'decide', 'stop', 'saveAutomation', 'pauseAutomation',
  'setHarness', 'setHarnessDefaults', 'pickOpenCode', 'setOpenCodePath', 'reconnectOpenCode',
  'runAutomation', 'removeAutomation', 'listProviders', 'saveProvider', 'removeProvider', 'discoverModels',
  'browserChromeHelp', 'browserOpenChrome', 'browserImportProfiles', 'browserPreviewProfile', 'browserChooseImport', 'browserApplyImport', 'browserExportBookmarks', 'saveBrowserPreferences',
  'browserNavigate', 'browserRestore', 'browserBounds', 'browserAction', 'browserClose', 'browserCapture', 'browserFind',
  'computerList', 'computerConnectDaytona', 'computerDisconnectDaytona', 'computerPickRuntime', 'computerInstallRuntime', 'computerInstallBrowser', 'computerCreate', 'computerStart',
  'computerStop', 'computerRemove', 'computerFrame', 'computerInput', 'computerTakeover',
  'inboxList', 'inboxConnect', 'inboxDisconnect', 'inboxRefresh', 'inboxTriage', 'inboxSaveDraft',
  'listIntegrations', 'saveIntegration', 'toggleIntegration', 'removeIntegration', 'inspectIntegration', 'importSkill', 'importExtension',
  'pickHarnessExecutable', 'setHarnessExecutable', 'setCustomAcp', 'setNativeModels', 'usageSummary', 'providerUsage', 'codexUsage', 'setUsageLimits', 'setRoutingRules',
  'memoryList', 'memorySave', 'memoryRemove', 'memoryEnabled', 'memoryDecide', 'saveProfile', 'savePreferences',
  'chooseKnowledgeVault', 'knowledgeList', 'knowledgeRemoveVault', 'knowledgeSearch', 'knowledgeGraph', 'knowledgeResolveLink',
  'noteLinks', 'fileTimeline', 'fileVersionPreview', 'restoreFileVersion', 'workspaceChanges', 'openNativeFiles', 'updateFavorite',
  'searchSources', 'saveSourceSearch', 'removeSourceSearch', 'copySourceLink', 'openIndexedFile', 'relinkIndexedFile',
  'tabMenu', 'addFavorite', 'removeFavorite', 'captureSource', 'chooseFolder', 'revealFile',
  'terminalStart', 'terminalWrite', 'terminalResize', 'terminalClose'];

function subscribe(name, listener) {
  const forward = (_, payload) => listener(payload);
  ipcRenderer.on(name, forward);
  return () => ipcRenderer.removeListener(name, forward);
}

contextBridge.exposeInMainWorld('workbench', {
  ...Object.fromEntries(operations.map((operation) => [operation, (...args) => ipcRenderer.invoke('wb:' + operation, ...args)])),
  onChange: (listener) => subscribe('wb:changed', listener),
  onTranscript: (listener) => subscribe('wb:transcript', listener),
  onReviewApproval: (listener) => subscribe('wb:review-approval', listener),
  onEditorProblems: (listener) => subscribe('wb:editor-problems', listener),
  onBrowser: (listener) => subscribe('wb:browser', listener),
  onChooseTab: (listener) => subscribe('wb:chooseTab', listener),
  onBrowserNavigation: (listener) => subscribe('wb:browserNavigation', listener),
  onBrowserOpen: (listener) => subscribe('wb:browserOpen', listener),
  onBrowserSaveError: (listener) => subscribe('wb:browserSaveError', listener),
  onBrowserAsk: (listener) => subscribe('wb:browserAsk', listener),
  onBrowserShortcut: (listener) => subscribe('wb:browserShortcut', listener),
  onComputerChange: (listener) => subscribe('wb:computer-change', listener),
  onNativeFiles: (listener) => subscribe('wb:nativeFiles', listener),
  onTerminal: (listener) => subscribe('wb:terminal', listener),
  platform: () => ipcRenderer.invoke('app:platform'),
  setAppearance: (scheme, background) => ipcRenderer.send('window:appearance', scheme, background),
  startResize: () => ipcRenderer.send('window:resize-start'),
  resizeWindow: (edge, dx, dy) => ipcRenderer.send('window:resize', { edge, dx, dy }),
  endResize: () => ipcRenderer.send('window:resize-end')
});
