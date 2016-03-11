const app = require('app');
const path = require('path');
const electron = require('electron');
const BrowserWindow = electron.BrowserWindow;
const {MenuManager} = require('./MenuManager');
const Config = require('../package.json');
const _ = require('lodash');
const ipc = electron.ipcMain;
const fs = require('fs');
const dialog = require('dialog');
const globalShortcut = electron.globalShortcut;
const {argv} = require('yargs')
                .usage('Usage: $0 [options]')
                .boolean('d')
                .alias('d', 'debug')
                .describe('d', 'Run in debug mode')
                .alias('e', 'editor')
                .nargs('e', 1)
                .describe('e', `REPL or Notebook(experimental) mode.
Allowed values:
  'repl', 'notebook'
                `)
                .example('$0 -e repl', 'Set editor mode as REPL')
                .alias('j', 'js-flags')
                .nargs('j', 1)
                .describe('j', `js flags for nodejs.`)
                .example('$0 --js-flags="--harmony_destructuring"', 'Enable destructuring harmony falg')
                .alias('l', 'lang')
                .nargs('l', 1)
                .describe('l', `Scripting language.
Allowed values:
  'js', 'javascript', 'babel'
  'ts', 'typescript'
  'ls', 'livescript'
  'coffee', 'coffeescript'
                `)
                .example('$0 -l ts', 'Set language as typescript')
                .alias('m', 'mode')
                .nargs('m', 1)
                .describe('m', `REPL mode (applicable only for --lang=js).
Allowed values:
  'magic', 'sloppy' or 'strict'
                `)
                .example('$0 -m strict', 'Set JS mode as strict')
                .alias('p', 'path')
                .nargs('p', 1)
                .describe('p', `Add npm path(s) with path delimiter`)
                .example('$0 -p /Users/princejohnwesley/Projects/Playground/sample', 'Add npm path')
                .alias('s', 'script')
                .nargs('s', 1)
                .describe('s', 'Start up script file to load.')
                .example('$0 -s script.js', 'Load script.js on start up')
                .alias('t', 'theme')
                .nargs('t', 1)
                .describe('t', `Editor theme.
Allowed values:
  dark', 'light'
                `)
                .example('$0 -t dark', 'Set dark theme')
                .help('h')
                .alias('h', 'help')
                .epilog(`Made with ♥︎ by toolitup.com
copyright 2015
                  `);

const HISTORY_FILE = path.join(app.getPath('userData'), '.mancy_history');
// babel leaking __core-js_shared__
const globalNames = Object.getOwnPropertyNames(global).filter(g => g !== '__core-js_shared__');
const windowCache = {};
const dockNotificationCache = {};
const menuManagerCache = {};
let windowCount = 0;
let promptOnClose = false;
let history = [];
let historySize = 0;
let noAccessToHistory = false;
const {Tray, Menu} = electron;

// set application root path as current working directory
process.chdir(app.getAppPath());

app.commandLine.appendSwitch('js-flags', argv.jsFlags || argv.j);

function onCloseWindow(e, title, detail) {
  // save history
  const window = BrowserWindow.getFocusedWindow();
  if(window && window.id && windowCache[window.id]) {
    saveHistory(null, windowCache[window.id].history);
    windowCache[window.id].history = [];
  }
  let ret = promptOnClose;
  if(promptOnClose) {
    try {
      ret = !!dialog.showMessageBox(window, {
        title: title || 'Close Window',
        buttons: ['Close', 'Cancel'],
        type: 'question',
        message: title || 'Close Window',
        detail: detail || `Do you want to close this window?`
      });
    } catch(e) { ret = false; }
  }
  if(ret) {  e.preventDefault(); }
  e.returnValue = !ret;
}

function onFocusWindow(e) {
  e.sender.webContents.send('application:focus');
}

function initHistory() {
  fs.readFile(HISTORY_FILE, (err, data) => {
    if(err) {
      if(err.code === 'ENOENT') {
        history = [];
        fs.writeFile(HISTORY_FILE, "[]", (err) => {
          if(err) {
            noAccessToHistory = true;
            console.error(`Failed to write history file ${err.message}`);
          }
        });
      } else { console.error(`Failed to read history file ${err.message}`); }
    } else {
      try {
        history = JSON.parse(data.toString());
      } catch(e) {
        // corrupted history
        history = []
      }
    }
  });
}

app.on('window-all-closed', () => {
  promptOnClose = false;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (e) => {
  let windows = BrowserWindow.getAllWindows();
  if(!windows.length) { return; }
  let window = BrowserWindow.getFocusedWindow();
  if(!window) {
    windows[0].show();
  }
  onCloseWindow(e, 'Quit Mancy', 'Do you want to quit?');
  if(e.returnValue) {
    promptOnClose = false;
  } else {
    e.preventDefault();
  }
});

app.on('browser-window-blur', (event, window) => window.$focus = false);

app.on('browser-window-focus', (event, window) => {
  window.$focus = true;
  dockNotificationCache[window.id] = 0;
  if (process.platform === 'darwin') {
    app.dock.setBadge('');
  }
});

function updateHistorySize(event, size) {
  if(size < 0) { return; }
  historySize = size;
  const sz = history.length;
  // when size is 0, stop writing history,(turn off)
  // dont erase it
  if(sz > size) {
    history = history.slice(sz - size);
  }
}

ipc.on('application:history-size', updateHistorySize);

ipc.on('application:history', (event) => event.returnValue = history);
ipc.on('application:history-append', (event, cmd = '') => {
  if(!cmd) { return; }
  let {id} = BrowserWindow.getFocusedWindow();
  let cache = windowCache[id];
  if(!cache.history) { cache.history = []; }
  cache.history.push(cmd);
});

ipc.on('application:history-aggressive', (event, flag) => {
  if(!flag) { return; }
  let {id} = BrowserWindow.getFocusedWindow();
  let cache = windowCache[id];
  if(cache.history && cache.history.length) {
    saveHistory(null, cache.history);
    cache.history = [];
  }
});

function saveHistory(event, cmds = []) {
  if(noAccessToHistory ||
    historySize === 0 ||
    !_.isArray(cmds) ||
    cmds.length === 0
  ) { return; }
  // remove adjacent duplicates
  history = _.uniq(history.concat(cmds), true);
  // trim history
  updateHistorySize(null, historySize);
  // rewrite
  fs.writeFile(HISTORY_FILE, JSON.stringify(history), (err) => {
    if(err) {
      noAccessToHistory = true;
      console.error(`Failed to write history file ${err.message}`);
    }
  });
}

ipc.on('application:history-save', saveHistory);


ipc.on('application:prompt-on-close', (event, flag) => promptOnClose = flag);

const langs =  {
  'js' : 'js', 'javascript' : 'js', 'babel': 'js',
  'ts': 'ts', 'typescript': 'ts',
  'ls': 'ls', 'livescript': 'ls',
  'coffee': 'coffee', 'coffeescript': 'coffee',
};
const modes = { 'magic': 'Magic', 'strict': 'Strict', 'sloppy': 'Sloppy' };
const editors =  { 'notebook': 'Notebook', 'repl': 'REPL' };
const themes = {
  'dark': 'application:view-theme-dark',
  'light': 'application:view-theme-light'
};
const processParamHandler = (browser) => {
  // theme option '-t' or '--theme'
  const theme = argv.t || argv.theme;
  if(theme && themes[theme]) {
    browser.webContents.send(themes[theme]);
  }

  // language option '-l' or '--lang'
  const lang = argv.l || argv.lang;
  if(lang && langs[lang]) {
    browser.webContents.send('application:prompt-language', langs[lang]);
    if(lang === 'babel') {
      browser.webContents.send('application:transpile-babel');
    }
  }

  // repl mode option '-m' or '--mode'
  const mode = argv.m || argv.mode;
  if(mode && modes[mode]) {
    browser.webContents.send('application:prompt-mode', modes[mode]);
  }

  // editor mode option '-e' or '--editor'
  const editor = argv.e || argv.editor;
  if(editor && editors[editor]) {
    browser.webContents.send('application:editor-mode', editors[editor]);
  }

  // load script option '-s' or '--script'
  const script = argv.s || argv.script;
  if(script) {
    browser.webContents.send('application:load-file', script);
  }
  // not so strict
  if(theme || lang || mode || editor || script) {
    browser.webContents.send('application:sync-session');
  }

  // add path
  const p = argv.p || argv.path;
  if(p) {
    browser.webContents.send('application:add-path', p.split(path.delimiter));
  }
};

function setUpTray() {
  const appIcon = new Tray(path.join(__dirname, '..', 'icons', 'mancy-tray.png'));
  const contextMenu = Menu.buildFromTemplate([{
    label: 'New',
    click: () => onReady()
  }]);

  appIcon.setToolTip('Mancy REPL');
  appIcon.setContextMenu(contextMenu);
  appIcon.on('click', () => {
    if(!BrowserWindow.getFocusedWindow()) {
      let windows = BrowserWindow.getAllWindows();
      if(!windows.length) {
        onReady();
      } else {
        windows[0].show();
      }
    }
  })
}

app.on('ready', (label) => {
  if(label) { setUpTray(); }
  onReady(label !== 'new-window' ? processParamHandler : null);
});
app.on('ready-action', onReady);
app.on('activate', (event, hasVisibleWindows) => {
  if(!hasVisibleWindows) {
    onReady();
  }
});

ipc.on('application:global-context-names', (event, options) => {
  event.returnValue = globalNames;
});

ipc.on('application:open-sync-resource', (event, options) => {
  event.returnValue = dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), options) || [];
});

ipc.on('application:message-box', function(event, options) {
  dialog.showMessageBox(BrowserWindow.getFocusedWindow(), options);
});

ipc.on('application:download', function(event, buffer) {
  let filename = dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Download to File…',
    filters: [
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if(filename) {
    fs.writeFile(filename, buffer, (err) => {
      let options = { buttons: ['Close'] };
      if(err) {
        options = _.extend(options, {
          title: 'Download Error',
          type: 'error',
          message: err.name || 'Export Error',
          detail: err.toString()
        });
      } else {
        options = _.extend(options, {
          title: 'Download Success',
          type: 'info',
          message: `Saved to ${filename}`
        });
      }
      dialog.showMessageBox(BrowserWindow.getFocusedWindow(), options);
    });
  }
});

ipc.on('application:dock-message-notification', function(event, id) {
  dockNotificationCache[id] = dockNotificationCache[id] + 1;
  if (process.platform === 'darwin') {
    app.dock.setBadge(`${dockNotificationCache[id]}`);
    app.dock.bounce();
  }
});

function onReady(fun) {
  let {width, height} = require('screen').getPrimaryDisplay().workAreaSize;
  let options = {
    width: width * 0.75,
    height: height * 0.75,
    minHeight: height * 0.5,
    minWidth: width * 0.5,
    resizable: true,
    webPreferences: {
      blinkFeatures: 'OverlayScrollbars',
      plugins: true,
      experimentalFeatures: true,
      experimentalCanvasFeatures: true,
      webgl: true
		},
    show: false,
  }
  if(process.platform === 'linux') {
    options.icon = path.resolve(__dirname, '..', 'icons', 'mancy.png');
  }
  let mainWindow = new BrowserWindow(options);
  let id = mainWindow.id;
  windowCache[id] = mainWindow;
  let menuManager = menuManagerCache[id] = new MenuManager(argv);

  mainWindow.loadURL(`file://${__dirname}/../index.html`);
  mainWindow.flashFrame(true);
  mainWindow.setTitle(`${_.capitalize(Config.name)} - REPL(${windowCount})`);
  windowCount += 1;

  mainWindow.on('closed',() => windowCache[id] = menuManagerCache[id] = null);
  mainWindow.on('close', onCloseWindow);
  mainWindow.on('focus', onFocusWindow);
  mainWindow.flashFrame(true);

  mainWindow.webContents.on('did-finish-load', () => {
    let totalActiveWindows = _.keys(windowCache).length;
    if(totalActiveWindows > 1) {
      let fixPos = (axis, adj) => {
        let naxis = axis + adj;
        return naxis <= 0 ? axis : naxis;
      };
      let [x, y] = mainWindow.getPosition();
      let adj = parseInt(Math.random() * 50) * (Math.random() > 0.3 ? -1: 1);
      let [nx, ny] = [fixPos(x, adj), fixPos(y, adj)];
      mainWindow.setPosition(nx, ny, true);
    }
    mainWindow.show();
    // Mac only
    if (process.platform === 'darwin') {
      mainWindow.showDefinitionForSelection(true);
      //mainWindow.setVisibleOnAllWorkspaces(true);
    }

    if(typeof fun === 'function') {
      fun(mainWindow);
    }
  });
}

initHistory();
