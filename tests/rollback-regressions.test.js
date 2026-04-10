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

runTest('chat panel uses an iframe-backed input inside a shadow host for focus isolation', () => {
  const content = read('content.js');

  assert.match(content, /const chatIframe = document\.createElement\('iframe'\);/);
  assert.match(content, /chatIframe\.src = 'about:blank';/);
  assert.match(content, /let _iframeTextarea = null;/);
  assert.match(content, /inputArea\.appendChild\(chatIframe\);/);
  assert.match(content, /chatShadowHost\.id = 'compose-assistant-chat-host';/);
  assert.match(content, /attachShadow\(\{ mode: 'closed' \}\)/);
});

runTest('fallback content-script injection includes text_writer before content.js', () => {
  const background = read('background.js');
  const injections = [...background.matchAll(/files:\s*\['text_writer\.js', 'content\.js'\]/g)];

  assert.ok(
    injections.length >= 2,
    `expected 2 fallback injections to include text_writer.js, found ${injections.length}`
  );
});
