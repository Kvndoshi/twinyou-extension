const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

runTest('background trusted replace selects all text before inserting', () => {
  const background = read('background.js');

  assert.match(background, /async function trustedReplaceText\(tabId, text, point\)/);
  assert.match(background, /async function captureTrustedReplaceState\(debuggee, point, label\)/);
  assert.match(background, /Runtime\.evaluate/);
  assert.match(background, /elementFromPoint\(x, y\)/);
  assert.match(background, /Input\.dispatchMouseEvent', \{\s*type: 'mousePressed'[\s\S]*button: 'left'[\s\S]*clickCount: 1/);
  assert.match(background, /Input\.dispatchMouseEvent', \{\s*type: 'mouseReleased'[\s\S]*button: 'left'[\s\S]*clickCount: 1/);
  assert.match(background, /Input\.dispatchKeyEvent', \{\s*type: 'rawKeyDown',[\s\S]*code: 'ControlLeft'[\s\S]*key: 'Control'[\s\S]*windowsVirtualKeyCode: 17/);
  assert.match(background, /Input\.dispatchKeyEvent', \{\s*type: 'rawKeyDown',[\s\S]*modifiers: 2[\s\S]*code: 'KeyA'[\s\S]*windowsVirtualKeyCode: 65[\s\S]*commands: \['selectAll'\]/);
  assert.match(background, /Input\.dispatchKeyEvent', \{\s*type: 'rawKeyDown'[\s\S]*commands: \['selectAll'\]/);
  assert.match(background, /Input\.insertText', \{ text \}/);
  assert.match(background, /selectionState = await captureTrustedReplaceState\(debuggee, point, 'after-select-all'\)/);
  assert.match(background, /hasTrustedSelection\(selectionState\)/);
  assert.match(background, /return \{ success: true \}/);
  assert.doesNotMatch(background, /code: 'Backspace'/);
  assert.doesNotMatch(background, /code: 'Delete'/);
});

runTest('content script uses trusted replace for Discord editors', () => {
  const content = read('content.js');

  assert.match(content, /window\.location\.hostname\.includes\('discord'\)/);
  assert.match(content, /type: 'TRUSTED_REPLACE_TEXT'/);
  assert.match(content, /const rect = target\.getBoundingClientRect\(\)/);
  assert.match(content, /x: Math\.round\(rect\.left \+ rect\.width \/ 2\)/);
  assert.match(content, /replaceResult = textWriter\.replaceContentEditableText\(el, text, \{/);
  assert.match(content, /slateMode: isDiscord \? 'manual-model' : undefined/);
  assert.match(content, /checkTextReplaceOutcome\(beforeText, afterText, text\)/);
  assert.doesNotMatch(content, /const sel = window\.getSelection\(\);[\s\S]{0,200}const range = document\.createRange\(\);[\s\S]{0,200}range\.selectNodeContents\(el\);[\s\S]{0,200}sel\.addRange\(range\);/);
});
