const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const toml = require('@iarna/toml');

const mainPath = path.resolve(__dirname, '../src/main.js');
const mainRequire = createRequire(mainPath);
const source = fs.readFileSync(mainPath, 'utf8');

function configFixture(t, initial = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokswitch-config-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, '.grok', 'config.toml');
  fs.mkdirSync(path.dirname(configPath));
  fs.writeFileSync(configPath, initial);
  const handlers = new Map();
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return {
        app: { whenReady: () => ({ then() {} }), on() {} },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      };
      if (name === 'os') return { ...os, homedir: () => root };
      return mainRequire(name);
    },
    __dirname: path.dirname(mainPath),
    process, console, Date,
  });
  vm.runInContext(source, context, { filename: mainPath });
  const helpers = vm.runInContext('({ loadConfig, saveConfig })', context);
  return {
    ...helpers, configPath,
    invoke: (name, value) => handlers.get(name)({}, value),
    read: () => toml.parse(fs.readFileSync(configPath, 'utf8')),
  };
}

test('model activation and repeated saves preserve zero sampling parameters', (t) => {
  const fixture = configFixture(t, `[models]\ndefault = "other"\n
[model.zero]\nmodel = "remote-zero"\ntemperature = 0\ntop_p = 0\n
[model.other]\nmodel = "remote-other"\ntemperature = 0.7\n`);
  const loaded = fixture.loadConfig();
  const zero = loaded.models.find((model) => model.id === 'zero');
  assert.equal(zero.temperature, 0);
  assert.equal(zero.top_p, 0);
  fixture.invoke('activate-model', 'zero');
  assert.equal(fixture.read().models.default, 'zero');
  assert.equal(fixture.read().model.zero.temperature, 0);
  assert.equal(fixture.read().model.zero.top_p, 0);
  fixture.saveConfig(fixture.loadConfig());
  assert.equal(fixture.read().model.zero.temperature, 0);
  assert.equal(fixture.read().model.zero.top_p, 0);
  assert.equal(fixture.read().model.other.temperature, 0.7);
});

test('quoted model IDs and unknown keys survive activation, editing, and deletion', (t) => {
  for (const id of ['provider.model', 'closing]bracket', 'quote"slash\\id', ' spaced key ', 'line\nbreak']) {
    const fixture = configFixture(t, `[models]\ndefault = ${JSON.stringify(id)}\n
[model.${JSON.stringify(id)}] # keep model settings\nmodel = "remote"\n"extra.with]bracket" = "retained"\n
[features]\nflag = true\n`);
    fixture.invoke('activate-model', id);
    assert.equal(fixture.loadConfig().models[0].id, id);
    assert.equal(fixture.read().model[id]['extra.with]bracket'], 'retained');
    fixture.invoke('add-or-update-model', { id, model: 'updated' });
    assert.equal(fixture.read().model[id].model, 'updated');
    assert.equal(fixture.read().features.flag, true);
    fixture.invoke('delete-model', id);
    assert.equal(fixture.loadConfig().models.length, 0);
    assert.equal(fixture.read().features.flag, true);
  }
});

test('section splitting preserves multiline text and unrelated arrays of tables', (t) => {
  const initial = `# preamble comment\n[models]\ndefault = "main"\n
[model.main]\nmodel = "remote"\n
[features] # preserved settings\nnote = """\n[model."not a table"]\nkeep this text\n"""\nvalues = [\n["models"]\n]\n
[[plugins]] # first plugin\nname = "one"\n
[[plugins]]\nname = "two"\n`;
  const fixture = configFixture(t, initial);
  const expected = toml.parse(initial);
  fixture.saveConfig(fixture.loadConfig());
  fixture.saveConfig(fixture.loadConfig());
  assert.deepEqual(fixture.read().features, expected.features);
  assert.deepEqual(fixture.read().plugins, expected.plugins);
  assert.deepEqual(Object.keys(fixture.read().model), ['main']);
  assert.ok(fs.readFileSync(fixture.configPath, 'utf8').includes('# first plugin'));
});

test('invalid generated or existing TOML never overwrites the current configuration', (t) => {
  const initial = '[model.main]\nmodel = "remote"\n';
  const fixture = configFixture(t, initial);
  const invalid = fixture.loadConfig();
  invalid.models.push({ id: 'main', model: 'duplicate' });
  assert.throws(() => fixture.saveConfig(invalid));
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), initial);
  assert.equal(fs.existsSync(`${fixture.configPath}.bak`), false);
  fs.writeFileSync(fixture.configPath, '[broken');
  assert.throws(() => fixture.saveConfig({ models: [] }));
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), '[broken');
});

test('renderer preserves quoted IDs and API keys in HTML attributes', () => {
  const id = '"<id]';
  const modal = { innerHTML: '', querySelectorAll: () => [] };
  const overlay = { classList: { add() {} } };
  const context = vm.createContext({
    document: { querySelector: (selector) => ({ '#modal': modal, '#modal-overlay': overlay })[selector] },
    fixtureConfig: { models: [{ id, model: 'remote', base_url: '', api_key: 'key"value' }] },
  });
  const renderer = fs.readFileSync(path.resolve(__dirname, '../src/renderer/main.js'), 'utf8');
  vm.runInContext(renderer.replace(/\nloadConfig\(\);\s*$/, ''), context);
  const cards = vm.runInContext('currentConfig = fixtureConfig; renderCards()', context);
  assert.match(cards, /data-id="&quot;&lt;id\]"/);
  context.editId = id;
  vm.runInContext('openModal(editId)', context);
  assert.match(modal.innerHTML, /id="input-id" value="&quot;&lt;id\]"/);
  assert.match(modal.innerHTML, /value="key&quot;value"/);
});

test('nested extra values and datetimes survive activation and repeated saves', (t) => {
  const initial = `[models]\ndefault = "main"\n
[model.main]\nmodel = "remote"\n
headers = { "X.Custom]Header" = "value", nested = { enabled = true, retries = 0 } }\n
profiles = [{ name = "first", nested = { numbers = [1, 2, 3] } }, { name = "second" }]\n
matrix = [[1, 2], [3, 4]]\nempty = {}\nempty_list = []\n
created_at = 1979-05-27T07:32:00Z\ndates = [1979-05-27T07:32:00Z, 1980-01-01T00:00:00Z]\n
local_date = 1979-05-27\nlocal_time = 07:32:00.000\nlarge_integer = 9223372036854775807\n`;
  const fixture = configFixture(t, initial);
  const expected = toml.parse(initial).model.main;
  fixture.invoke('activate-model', 'main');
  fixture.saveConfig(fixture.loadConfig());
  assert.deepEqual(fixture.read().model.main, expected);
  assert.equal(fs.readFileSync(`${fixture.configPath}.bak`, 'utf8').includes('created_at = 1979-05-27T07:32:00.000Z'), true);

  fixture.invoke('add-or-update-model', { id: 'main', model: 'edited' });
  assert.deepEqual(fixture.read().model.main.headers, expected.headers);
  assert.deepEqual(fixture.read().model.main.profiles, expected.profiles);
  assert.ok(fixture.read().model.main.created_at instanceof Date);
});

test('invalid nested values leave both configuration and previous backup intact', (t) => {
  const fixture = configFixture(t, '[model.main]\nmodel = "remote"\n');
  fixture.saveConfig(fixture.loadConfig());
  const original = fs.readFileSync(fixture.configPath, 'utf8');
  const backup = fs.readFileSync(`${fixture.configPath}.bak`, 'utf8');
  const cycle = {};
  cycle.self = cycle;
  for (const value of [[null], { invalid: null }, { invalid: undefined }, { invalid: new Date(NaN) }, { invalid: () => {} }, cycle]) {
    const config = fixture.loadConfig();
    config.models[0].extra = { custom: value };
    assert.throws(() => fixture.saveConfig(config));
    assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), original);
    assert.equal(fs.readFileSync(`${fixture.configPath}.bak`, 'utf8'), backup);
  }
});
