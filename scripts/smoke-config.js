/**
 * Smoke test for config backup + non-model section preservation.
 * Does not launch Electron; mirrors the algorithms in src/main.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const toml = require('toml');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokswitch-smoke-'));
const configDir = path.join(root, '.grok');
const configPath = path.join(configDir, 'config.toml');
const backupPath = path.join(configDir, 'config.toml.bak');
fs.mkdirSync(configDir, { recursive: true });

const INITIAL = `# keep this top comment
# owner: smoke-test

[models]
default = "a"

[model.a]
model = "model-a"
name = "Model A"
base_url = "https://example.com/v1"
api_key = "sk-test"

# custom section should survive
[features]
experimental = true
# trailing note in features
note = "hello"

[other.nested]
value = 42
`;

fs.writeFileSync(configPath, INITIAL, 'utf-8');

// --- minimal copy of save helpers from main.js ---
function stripBom(raw) {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function splitTomlSections(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const sections = [];
  let preambleLines = [];
  let current = null;
  const headerRe = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/;

  for (const line of lines) {
    const match = line.match(headerRe);
    if (match) {
      if (current) sections.push(current);
      current = { name: match[1].trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  if (current) sections.push(current);
  while (preambleLines.length && preambleLines[preambleLines.length - 1].trim() === '') {
    preambleLines.pop();
  }
  return {
    preamble: preambleLines.join('\n'),
    sections: sections.map((s) => ({
      name: s.name,
      raw: s.lines.join('\n').replace(/\n+$/, ''),
    })),
  };
}

function formatTomlValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
  return JSON.stringify(value);
}

function formatKeyValue(key, value) {
  const formatted = formatTomlValue(value);
  if (formatted === null) return '';
  return `${key} = ${formatted}`;
}

function buildModelsTable(defaultModel) {
  const lines = ['[models]'];
  if (defaultModel) lines.push(formatKeyValue('default', defaultModel));
  return lines.join('\n');
}

function buildModelTable(entry) {
  const lines = [`[model.${entry.id}]`];
  lines.push(formatKeyValue('model', entry.model));
  if (entry.name) lines.push(formatKeyValue('name', entry.name));
  if (entry.base_url) lines.push(formatKeyValue('base_url', entry.base_url));
  if (entry.api_key) lines.push(formatKeyValue('api_key', entry.api_key));
  return lines.join('\n');
}

function saveConfig(config) {
  const existingRaw = stripBom(fs.readFileSync(configPath, 'utf-8'));
  fs.copyFileSync(configPath, backupPath);

  const { preamble, sections } = splitTomlSections(existingRaw);
  const preserved = sections
    .filter((s) => s.name !== 'models' && !s.name.startsWith('model.'))
    .map((s) => s.raw);

  const blocks = [];
  if (preamble.trim()) blocks.push(preamble.trimEnd());
  blocks.push(buildModelsTable(config.default_model));
  for (const entry of config.models) blocks.push(buildModelTable(entry));
  for (const raw of preserved) {
    if (raw.trim()) blocks.push(raw.trimEnd());
  }
  fs.writeFileSync(configPath, `${blocks.join('\n\n')}\n`, 'utf-8');
}

// Activate model B (add B + set default)
saveConfig({
  default_model: 'b',
  models: [
    {
      id: 'a',
      model: 'model-a',
      name: 'Model A',
      base_url: 'https://example.com/v1',
      api_key: 'sk-test',
    },
    {
      id: 'b',
      model: 'model-b',
      name: 'Model B',
      base_url: 'https://example.com/v1',
      api_key: 'sk-b',
    },
  ],
});

const after = fs.readFileSync(configPath, 'utf-8');
const bak = fs.readFileSync(backupPath, 'utf-8');
const parsed = toml.parse(after);

const checks = [];
function assert(name, cond) {
  checks.push({ name, ok: !!cond });
  if (!cond) console.error('FAIL:', name);
  else console.log('OK  :', name);
}

assert('backup exists and matches initial', bak === INITIAL);
assert('default switched to b', parsed.models.default === 'b');
assert('model a kept', parsed.model?.a?.model === 'model-a');
assert('model b added', parsed.model?.b?.model === 'model-b');
assert('features section preserved', parsed.features?.experimental === true);
assert('features note preserved', parsed.features?.note === 'hello');
assert('other.nested preserved', parsed.other?.nested?.value === 42);
assert('top comments preserved', after.includes('# keep this top comment'));
assert('inline comment in features preserved', after.includes('# trailing note in features'));

const failed = checks.filter((c) => !c.ok);
console.log('\nTemp dir:', root);
console.log('--- written config ---');
console.log(after);
console.log(`\n${checks.length - failed.length}/${checks.length} passed`);

if (failed.length) process.exitCode = 1;
