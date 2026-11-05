const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  session,
  shell,
} = require('electron');
const path = require('node:path');

const APP_NAME = 'Luma';
const APP_ID = 'com.luma.imagegen';
let runtime = null;
let mainWindow = null;
let quitting = false;

app.setName(APP_NAME);
// Full rename: use a fresh userData directory. Legacy 画境 data is left untouched.
app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!runtime) return;
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('Luma 启动失败', error?.stack || String(error));
    app.quit();
  });
}

async function start() {
  configureEnvironment();
  const { startServer } = await import('../src/bootstrap/start-server.js');
  runtime = await startServer({ host: '127.0.0.1', port: 0 });
  setupDownloads();
  installMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function configureEnvironment() {
  process.env.DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  if (process.env.ALLOW_REGISTRATION === undefined) process.env.ALLOW_REGISTRATION = '1';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  const appOrigin = new URL(`http://127.0.0.1:${runtime.port}`).origin;
  mainWindow.loadURL(appOrigin);

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin === appOrigin) return;
    } catch {
      /* fall through and block invalid URLs */
    }
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
}

function setupDownloads() {
  session.defaultSession.on('will-download', (event, item, webContents) => {
    const parent = BrowserWindow.fromWebContents(webContents) || mainWindow;
    const defaultPath = path.join(app.getPath('downloads'), item.getFilename());
    const savePath = dialog.showSaveDialogSync(parent, {
      title: '保存图片',
      defaultPath,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (!savePath) {
      event.preventDefault();
      return;
    }
    item.setSavePath(savePath);
  });
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: 'about', label: `关于 ${APP_NAME}` },
              { type: 'separator' },
              { role: 'hide', label: `隐藏 ${APP_NAME}` },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: `退出 ${APP_NAME}` },
            ],
          },
        ]
      : []),
    {
      label: '文件',
      submenu: [
        { role: 'close', label: '关闭窗口' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac ? [{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  runtime?.close();
});
