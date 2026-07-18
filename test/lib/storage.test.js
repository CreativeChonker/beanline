const { test } = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../../lib/storage');

test('uploadImage stores a file in object storage and returns a URL that serves it back', async () => {
  const contents = 'fake image bytes ' + Date.now();
  const buffer = Buffer.from(contents);
  const url = await storage.uploadImage(buffer, `test/${Date.now()}.jpg`, 'image/jpeg');

  assert.match(url, /^http/);

  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, contents);
});
