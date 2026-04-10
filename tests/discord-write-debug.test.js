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

runTest('content script checks Discord write outcome without debug infrastructure', () => {
  const content = read('content.js');

  assert.match(content, /function checkTextReplaceOutcome\(beforeText, afterText, text\)/);
  assert.match(content, /checkTextReplaceOutcome\(beforeText, afterText, text\)/);
  assert.doesNotMatch(content, /DISCORD_WRITE_DEBUG_SUMMARY/);
  assert.doesNotMatch(content, /STORE_DISCORD_WRITE_DEBUG/);
  assert.doesNotMatch(content, /captureDiscordWriteSnapshot/);
});

runTest('background does not store Discord write debug history', () => {
  const background = read('background.js');

  assert.doesNotMatch(background, /STORE_DISCORD_WRITE_DEBUG/);
  assert.doesNotMatch(background, /discordWriteDebug/);
});

runTest('content script preserves Slate placeholder markers long enough to hide overlays', () => {
  const content = read('content.js');

  assert.match(content, /function hideSlatePlaceholder\(node\)/);
  assert.match(content, /const placeholderAttrs = \['data-placeholder', 'aria-placeholder'\]/);
  assert.match(content, /const slatePlaceholderNodes = Array\.from\(el\.querySelectorAll\('\[data-slate-placeholder\]'\)\)/);
  assert.match(content, /slatePlaceholderNodes\.forEach\(hideSlatePlaceholder\)/);
});
