// A received text containing NUL cannot be stored in PostgreSQL; text decoding must also preserve
// ordinary Unicode, whitespace and escaped text, cover other charsets, and leave binary bytes intact.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { config } from "@aihot/backend/config";
import { guardedFetch } from "@aihot/backend/lib/http-fetch";

const previous = getGlobalDispatcher();
const previousPrivate = config.allowPrivateNetworkFetch;
const mock = new MockAgent();
mock.disableNetConnect();
setGlobalDispatcher(mock);
config.allowPrivateNetworkFetch = true;
after(async () => {
  config.allowPrivateNetworkFetch = previousPrivate;
  setGlobalDispatcher(previous);
  await mock.close();
});

async function read(path: string, bytes: Buffer, contentType = "text/plain; charset=utf-8") {
  mock.get("https://text.invalid").intercept({ path }).reply(200, bytes, { headers: { "content-type": contentType } });
  return guardedFetch(`https://text.invalid${path}`, { route: "direct" });
}

test("received NUL text is representable in PostgreSQL while the original bytes remain intact", async () => {
  const bytes = Buffer.from("Title: 正文\nMarkdown Content:\n甲\0乙😀\n\t\\u0000");
  const response = await read("/nul", bytes);
  assert.equal(response.text(), "Title: 正文\nMarkdown Content:\n甲�乙😀\n\t\\u0000");
  assert.deepEqual(response.body, bytes);
});

test("normal text and its escaped NUL notation are unchanged", async () => {
  const text = "中文😀\n\t\\u0000";
  assert.equal((await read("/ordinary", Buffer.from(text))).text(), text);
});

test("NUL is handled after decoding a declared non-UTF8 charset", async () => {
  assert.equal((await read("/latin1", Buffer.from([0xe9, 0, 0x61]), "text/plain; charset=windows-1252")).text(), "é�a");
});

test("a quoted charset in Content-Type is honoured", async () => {
  assert.equal((await read("/quoted", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/html; charset="gb2312"')).text(), "中文");
});

test("JSON strings containing an old HTML charset cannot change UTF-8 response decoding", async () => {
  const original = JSON.stringify({ docClob: '<html><head><meta charset="gb2312"></head><body>监管总局依法开展保险监管。</body></html>' });
  for (const contentType of ["application/json", "application/problem+json"]) {
    const response = await read("/json-" + contentType.length, Buffer.from(original), contentType);
    assert.equal(response.text(), original);
    assert.deepEqual(response.body, Buffer.from(original));
  }
});
