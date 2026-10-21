const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const toml = require('toml');

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
