const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const toml = require('toml');

const CONFIG_DIR = path.join(os.homedir(), '.grok');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return { default_model: null, models: [] };
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = toml.parse(content);
    const defaultModel = parsed.models?.default || null;
    const models = [];

    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('model.') && typeof value === 'object' && value !== null) {
        const id = key.replace('model.', '');
        models.push({
          id,
          model: value.model || '',
          name: value.name || '',
          base_url: value.base_url || '',
          api_backend: value.api_backend || 'chat_completions',
          api_key: value.api_key || undefined,
          env_key: value.env_key || undefined,
          context_window: value.context_window || undefined,
          max_completion_tokens: value.max_completion_tokens || undefined,
          temperature: value.temperature || undefined,
          top_p: value.top_p || undefined,
        });
      }
    }
    return { default_model: defaultModel, models };
  } catch (err) {
    throw new Error(`读取配置失败: ${err.message}`);
  }
}

function saveConfig(config) {
  ensureConfigDir();
  let parsed = {};

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      parsed = toml.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch {
      parsed = {};
    }
  }

  // Update [models] section
  if (!parsed.models) parsed.models = {};
  if (config.default_model) {
    parsed.models.default = config.default_model;
  } else {
    delete parsed.models.default;
  }

  // Remove all [model.*] sections
  for (const key of Object.keys(parsed)) {
    if (key.startsWith('model.')) delete parsed[key];
  }

  // Add model sections
  for (const entry of config.models) {
    const section = {};
    section.model = entry.model;
    if (entry.name) section.name = entry.name;
    if (entry.base_url) section.base_url = entry.base_url;
    if (entry.api_backend && entry.api_backend !== 'chat_completions') {
      section.api_backend = entry.api_backend;
    }
    if (entry.api_key) section.api_key = entry.api_key;
    if (entry.env_key) section.env_key = entry.env_key;
    if (entry.context_window !== undefined) section.context_window = entry.context_window;
    if (entry.max_completion_tokens !== undefined) section.max_completion_tokens = entry.max_completion_tokens;
    if (entry.temperature !== undefined) section.temperature = entry.temperature;
    if (entry.top_p !== undefined) section.top_p = entry.top_p;

    parsed[`model.${entry.id}`] = section;
  }

  const content = stringifyToml(parsed);
  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
}

function stringifyToml(obj, prefix = '') {
  let lines = [];

  // Simple top-level key-values first
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      continue;
    }
    lines.push(formatKeyValue(key, value));
  }

  // Then tables
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (lines.length > 0) lines.push('');
      lines.push(`${prefix}[${key}]`);
      for (const [k, v] of Object.entries(value)) {
        lines.push(formatKeyValue(k, v, '  '));
      }
    }
  }

  return lines.join('\n') + '\n';
}

function formatKeyValue(key, value, indent = '') {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    const quoted = value.includes('"') || value.includes('\n') || value.includes('#') || value === '';
    return `${indent}${key} = ${quoted ? JSON.stringify(value) : '"' + value + '"'}`;
  }
  if (typeof value === 'number') return `${indent}${key} = ${value}`;
  if (typeof value === 'boolean') return `${indent}${key} = ${value}`;
  if (Array.isArray(value)) {
    return `${indent}${key} = [${value.map(v => JSON.stringify(v)).join(', ')}]`;
  }
  return `${indent}${key} = ${JSON.stringify(value)}`;
}

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('save-config', (_event, config) => {
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('activate-model', (_event, id) => {
  const config = loadConfig();
  if (!config.models.some(m => m.id === id)) {
    throw new Error(`模型 ${id} 不存在`);
  }
  config.default_model = id;
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('add-or-update-model', (_event, entry) => {
  const config = loadConfig();
  const idx = config.models.findIndex(m => m.id === entry.id);
  if (idx >= 0) {
    config.models[idx] = entry;
  } else {
    config.models.push(entry);
  }
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('delete-model', (_event, id) => {
  const config = loadConfig();
  config.models = config.models.filter(m => m.id !== id);
  if (config.default_model === id) {
    config.default_model = config.models[0]?.id || null;
  }
  saveConfig(config);
  return loadConfig();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 520,
    title: 'GrokSwitch',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0f0f13',
    show: false,
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const labels = ['debug', 'log', 'warn', 'error'];
    console.log(`[renderer:${labels[level] || level}] ${sourceId}:${line} ${message}`);
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  // win.webContents.openDevTools();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
