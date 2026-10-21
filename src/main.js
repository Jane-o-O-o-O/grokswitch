const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const toml = require('@iarna/toml');

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

function tableHeader(line) {
  if (!line.trimStart().startsWith('[')) return null;
  try {
    let table = toml.parse(`${line}\n`);
    const keys = [];
    while (table && typeof table === 'object' && !Array.isArray(table)) {
      const names = Object.keys(table);
      if (names.length !== 1) break;
      keys.push(names[0]);
      table = table[names[0]];
    }
    if (!keys.length) return null;
    return {
      name: keys.join('.'),
      managed: (keys[0] === 'models' && keys.length === 1) ||
        (keys[0] === 'model' && keys.length > 1) ||
        (keys.length === 1 && keys[0].startsWith('model.')),
    };
  } catch {
    return null;
  }
}

function nextTomlState(line, state) {
  let { quote, arrayDepth } = state;
  for (let i = 0; i < line.length; i++) {
    if (quote) {
      if (quote.startsWith('"') && line[i] === '\\') { i++; continue; }
      if (line.startsWith(quote, i)) {
        let length = quote.length;
        if (length === 3) while (line[i + length] === quote[0]) length++;
        i += length - 1;
        quote = null;
      }
    } else {
      if (line[i] === '#') break;
      if (line[i] === '"' || line[i] === "'") {
        quote = line.startsWith(line[i].repeat(3), i) ? line[i].repeat(3) : line[i];
        i += quote.length - 1;
      }
      if (line[i] === '[') arrayDepth++;
      if (line[i] === ']') arrayDepth = Math.max(0, arrayDepth - 1);
    }
  }
  return { quote, arrayDepth };
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

  let state = { quote: null, arrayDepth: 0 };

  for (const line of lines) {
    const header = state.quote || state.arrayDepth ? null : tableHeader(line);
    if (header) {
      if (current) {
        sections.push(current);
      } else if (preambleLines.length) {
        // trailing blanks before first table stay with preamble
      }
      current = { ...header, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
    state = nextTomlState(line, state);
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
      managed: s.managed,
      raw: trimSectionRaw(s.lines.join('\n')),
    })),
  };
}

function trimSectionRaw(text) {
  return text.replace(/\n+$/, '');
}

function validateTomlValue(value, ancestors = new Set()) {
  if (value === undefined || value === null) throw new Error('TOML 不能包含空值');
  if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return;
  if (typeof value !== 'object') throw new Error(`TOML 不支持 ${typeof value} 类型`);
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('TOML 日期无效');
    return;
  }
  if (ancestors.has(value)) throw new Error('TOML 配置不能包含循环引用');
  ancestors.add(value);
  try {
    const items = Array.isArray(value) ? Array.from(value) : Object.values(value);
    for (const item of items) validateTomlValue(item, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function formatTomlValue(value) {
  if (value === undefined || value === null) return null;
  validateTomlValue(value);
  return toml.stringify.value(value);
}

function formatKeyValue(key, value, indent = '') {
  const formatted = formatTomlValue(value);
  if (formatted === null) return '';
  return `${indent}${formatTomlKey(key)} = ${formatted}`;
}

function formatTomlKey(key) {
  const value = String(key);
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function buildModelsTable(defaultModel) {
  const lines = ['[models]'];
  if (defaultModel) {
    lines.push(formatKeyValue('default', defaultModel));
  }
  return lines.join('\n');
}

function buildModelTable(entry) {
  const lines = [`[model.${formatTomlKey(entry.id)}]`];
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
    const parsed = toml.parse(existingRaw);
    const { preamble: p, sections } = splitTomlSections(existingRaw);
    preamble = p;
    for (const sec of sections) {
      if (sec.managed) continue;
      preservedSections.push(sec.raw);
    }

    // Merge extra fields from disk for models that still exist, if client omitted them
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
  toml.parse(content);
  backupConfig();
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
