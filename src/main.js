const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const toml = require('toml');

const CONFIG_DIR = path.join(os.homedir(), '.grok');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.toml');
const CONFIG_BACKUP_PATH = path.join(CONFIG_DIR, 'config.toml.bak');

const MODEL_KNOWN_KEYS = new Set([
  'model',
  'name',
  'base_url',
  'api_backend',
  'api_key',
  'env_key',
  'context_window',
  'max_completion_tokens',
  'temperature',
  'top_p',
]);

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function readRawConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  return stripBom(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/** Copy existing config to config.toml.bak before any write. */
function backupConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return false;
  ensureConfigDir();
  fs.copyFileSync(CONFIG_PATH, CONFIG_BACKUP_PATH);
  return true;
}

/**
 * Split TOML into preamble (leading comments / blank lines) and named sections.
 * Non-model sections are kept as raw text so comments/formatting survive.
 */
function splitTomlSections(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let preambleLines = [];
  let current = null;

  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

  for (const line of lines) {
    const match = line.match(headerRe);
    if (match) {
      if (current) {
        sections.push(current);
      } else if (preambleLines.length) {
        // trailing blanks before first table stay with preamble
      }
      current = { name: match[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);

  // Drop trailing empty lines from preamble
  while (preambleLines.length && preambleLines[preambleLines.length - 1].trim() === '') {
    preambleLines.pop();
  }

  return {
    preamble: preambleLines.join('\n'),
    sections: sections.map((s) => ({
      name: s.name,
      raw: trimSectionRaw(s.lines.join('\n')),
    })),
  };
}

function trimSectionRaw(text) {
  return text.replace(/\n+$/, '');
}

function formatTomlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    // Nested tables are not expected here; stringify as inline table-ish JSON fallback
    return JSON.stringify(value);
  }
  return JSON.stringify(String(value));
}

function formatKeyValue(key, value, indent = '') {
  const formatted = formatTomlValue(value);
  if (formatted === null) return '';
  return `${indent}${key} = ${formatted}`;
}

function buildModelsTable(defaultModel) {
  const lines = ['[models]'];
  if (defaultModel) {
    lines.push(formatKeyValue('default', defaultModel));
  }
  return lines.join('\n');
}

function buildModelTable(entry) {
  const lines = [`[model.${entry.id}]`];
  const section = {};

  section.model = entry.model;
  if (entry.name) section.name = entry.name;
  if (entry.base_url) section.base_url = entry.base_url;
  if (entry.api_backend && entry.api_backend !== 'chat_completions') {
    section.api_backend = entry.api_backend;
  }
  if (entry.api_key) section.api_key = entry.api_key;
  if (entry.env_key) section.env_key = entry.env_key;
  if (entry.context_window !== undefined && entry.context_window !== null && entry.context_window !== '') {
    section.context_window = entry.context_window;
  }
  if (entry.max_completion_tokens !== undefined && entry.max_completion_tokens !== null && entry.max_completion_tokens !== '') {
    section.max_completion_tokens = entry.max_completion_tokens;
  }
  if (entry.temperature !== undefined && entry.temperature !== null && entry.temperature !== '') {
    section.temperature = entry.temperature;
  }
  if (entry.top_p !== undefined && entry.top_p !== null && entry.top_p !== '') {
    section.top_p = entry.top_p;
  }

  // Preserve unknown keys previously present on this model
  if (entry.extra && typeof entry.extra === 'object') {
    for (const [k, v] of Object.entries(entry.extra)) {
      if (!(k in section) && v !== undefined) section[k] = v;
    }
  }

  for (const [k, v] of Object.entries(section)) {
    const line = formatKeyValue(k, v);
    if (line) lines.push(line);
  }
  return lines.join('\n');
}

function modelEntryFromValue(id, value) {
  const extra = {};
  for (const [k, v] of Object.entries(value)) {
    if (!MODEL_KNOWN_KEYS.has(k)) extra[k] = v;
  }
  return {
    id,
    model: value.model || '',
    name: value.name || '',
    base_url: value.base_url || '',
    api_backend: value.api_backend || 'chat_completions',
    api_key: value.api_key || undefined,
    env_key: value.env_key || undefined,
    context_window: value.context_window ?? undefined,
    max_completion_tokens: value.max_completion_tokens ?? undefined,
    temperature: value.temperature ?? undefined,
    top_p: value.top_p ?? undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

/**
 * Collect [model.*] tables. The `toml` package parses [model.foo] as nested
 * objects (parsed.model.foo), not flat keys "model.foo".
 */
function collectModels(parsed) {
  const models = [];
  const seen = new Set();

  if (parsed.model && typeof parsed.model === 'object' && !Array.isArray(parsed.model)) {
    for (const [id, value] of Object.entries(parsed.model)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        models.push(modelEntryFromValue(id, value));
        seen.add(id);
      }
    }
  }

  // Fallback for unusual flat keys if any
  for (const [key, value] of Object.entries(parsed)) {
    if (!key.startsWith('model.') || typeof value !== 'object' || value === null) continue;
    const id = key.slice('model.'.length);
    if (seen.has(id)) continue;
    models.push(modelEntryFromValue(id, value));
    seen.add(id);
  }

  return models;
}

function getParsedModelTable(parsed, id) {
  if (parsed.model && typeof parsed.model === 'object' && parsed.model[id]) {
    return parsed.model[id];
  }
  return parsed[`model.${id}`] || null;
}

function loadConfig() {
  const raw = readRawConfig();
  if (raw === null) {
    return {
      default_model: null,
      models: [],
      config_path: CONFIG_PATH,
      backup_path: CONFIG_BACKUP_PATH,
      has_backup: fs.existsSync(CONFIG_BACKUP_PATH),
    };
  }

  try {
    const parsed = toml.parse(raw);
    const defaultModel = parsed.models?.default || null;
    const models = collectModels(parsed);

    return {
      default_model: defaultModel,
      models,
      config_path: CONFIG_PATH,
      backup_path: CONFIG_BACKUP_PATH,
      has_backup: fs.existsSync(CONFIG_BACKUP_PATH),
    };
  } catch (err) {
    throw new Error(`读取配置失败: ${err.message}`);
  }
}

/**
 * Write config while:
 * 1) backing up the previous file
 * 2) keeping non-model TOML sections (and their comments) as raw text
 * 3) rewriting only [models] + [model.*]
 */
function saveConfig(config) {
  ensureConfigDir();

  let preamble = '';
  const preservedSections = [];

  const existingRaw = readRawConfig();
  if (existingRaw !== null) {
    backupConfig();
    try {
      const { preamble: p, sections } = splitTomlSections(existingRaw);
      preamble = p;
      for (const sec of sections) {
        if (sec.name === 'models' || sec.name.startsWith('model.')) continue;
        preservedSections.push(sec.raw);
      }
    } catch {
      // If split fails, fall back to empty preserve list (backup already made)
    }

    // Merge extra fields from disk for models that still exist, if client omitted them
    try {
      const parsed = toml.parse(existingRaw);
      for (const entry of config.models) {
        const prev = getParsedModelTable(parsed, entry.id);
        if (!prev || typeof prev !== 'object') continue;
        if (entry.extra) continue;
        const extra = {};
        for (const [k, v] of Object.entries(prev)) {
          if (!MODEL_KNOWN_KEYS.has(k)) extra[k] = v;
        }
        if (Object.keys(extra).length) entry.extra = extra;
      }
    } catch {
      // ignore
    }
  }

  const blocks = [];
  if (preamble && preamble.trim()) {
    blocks.push(preamble.trimEnd());
  }
  blocks.push(buildModelsTable(config.default_model));
  for (const entry of config.models) {
    blocks.push(buildModelTable(entry));
  }
  for (const raw of preservedSections) {
    if (raw && raw.trim()) blocks.push(raw.trimEnd());
  }

  const content = `${blocks.join('\n\n')}\n`;
  fs.writeFileSync(CONFIG_PATH, content, 'utf-8');
}

ipcMain.handle('load-config', () => loadConfig());

ipcMain.handle('save-config', (_event, config) => {
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('activate-model', (_event, id) => {
  const config = loadConfig();
  if (!config.models.some((m) => m.id === id)) {
    throw new Error(`模型 ${id} 不存在`);
  }
  config.default_model = id;
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('add-or-update-model', (_event, entry) => {
  const config = loadConfig();
  const idx = config.models.findIndex((m) => m.id === entry.id);
  if (idx >= 0) {
    // Keep previous extra keys unless client sent a full replacement
    const prev = config.models[idx];
    config.models[idx] = {
      ...prev,
      ...entry,
      extra: entry.extra !== undefined ? entry.extra : prev.extra,
    };
  } else {
    config.models.push(entry);
  }
  saveConfig(config);
  return loadConfig();
});

ipcMain.handle('delete-model', (_event, id) => {
  const config = loadConfig();
  config.models = config.models.filter((m) => m.id !== id);
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
