const fs = require('fs');

const ok = (name, cond) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) process.exitCode = 1;
};

let currentModelText = '';
let modelItems = [];

global.document = {
  querySelector: (sel) => {
    if (sel.includes('model-selector-text') || sel.includes('model-name')) {
      return currentModelText ? { textContent: currentModelText } : null;
    }
    return null;
  },
  querySelectorAll: (sel) => {
    if (sel.includes('model-item___')) {
      return modelItems;
    }
    return [];
  },
  addEventListener: () => {},
  dispatchEvent: () => {},
  documentElement: {
    classList: { contains: () => false },
    setAttribute: () => {},
  },
  body: null,
};
global.window = {
  location: { pathname: '/' },
  addEventListener: () => {},
  HTMLTextAreaElement: { prototype: {} },
};
global.location = global.window.location;
global.localStorage = {
  getItem: () => null,
  setItem: () => {},
};
global.MutationObserver = class {
  observe() {}
  disconnect() {}
};

const code = fs.readFileSync(__dirname + '/providers/qwen.js', 'utf8');
const ZSProvider = new Function(code + '; return ZSProvider;')();

function testModel(name, expectedVision) {
  currentModelText = name;
  const actual = ZSProvider.supportsVision;
  ok(`model '${name}' -> supportsVision: ${expectedVision}`, actual === expectedVision);
}

testModel('Qwen3.8-Max', true);
testModel('Qwen 3.8 Max', true);
testModel('Qwen3.8 Max', true);
testModel('qwen 3.8 max', true);
testModel('Qwen3.8-Max-Preview', true);
testModel('Qwen 3.8 Max Preview', true);
testModel('Qwen3.8-Plus', true);
testModel('Qwen 3.8 Plus', true);
testModel('Qwen-Plus', true);
testModel('Qwen3.7-Plus', true);
testModel('Qwen3.6-Plus', true);
testModel('Qwen3.5-Plus', true);
testModel('Qwen-VL-Max', true);
testModel('Qwen2.5-VL-72B', true);
testModel('Qwen2.5-VL-7B', true);
testModel('Qwen2-VL', true);
testModel('Qwen3.7-Max', false);
testModel('Qwen 3.7 Max', false);
testModel('Qwen3.6-Max-Preview', false);
testModel('Qwen3.6-Max', false);
testModel('QwQ-32B', false);
testModel('Qwen3.9-Max', true);
testModel('Qwen4-Max', true);
testModel('Qwen3.8-Something', true);
testModel('Qwen-Vision-Pro', true);
