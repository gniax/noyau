import assert from "node:assert/strict";
import test from "node:test";
import { KnowledgeService, notionId, parseDriveFolder } from "./knowledge-service.js";

class MemoryStore {
  constructor(data = {}) { this.data = data; }
  get(id) { return this.data[id] || null; }
  async set(id, value) { this.data[id] = value; }
}

test("Drive public folder parser exposes folders and readable docs", () => {
  const html = '<div class="flip-entry" id="entry-folder123456" role="link"><a href="https://drive.google.com/drive/folders/folder123456"><div aria-label="Folder"></div><div class="flip-entry-title">Boards &amp; UX</div></a><div class="flip-entry-last-modified"><div>Aug 2</div></div></div><div class="flip-entry" id="entry-doc123456789" role="link"><a href="https://docs.google.com/document/d/doc123456789/edit"><div class="flip-entry-title">Prompt</div></a><div class="flip-entry-last-modified"><div>Aug 7</div></div></div>';
  assert.deepEqual(parseDriveFolder(html).map(({ id, name, kind, readable }) => ({ id, name, kind, readable })), [
    { id: "folder123456", name: "Boards & UX", kind: "folder", readable: false },
    { id: "doc123456789", name: "Prompt", kind: "document", readable: true },
  ]);
});

test("Notion page id accepts URL and service never returns token", async () => {
  assert.equal(notionId("https://www.notion.so/Atlas-0123456789abcdef0123456789abcdef?pvs=4"), "0123456789abcdef0123456789abcdef");
  const store = new MemoryStore();
  const responses = [
    { name: "Noyau" },
    { results: [{ object: "page", id: "01234567-89ab-cdef-0123-456789abcdef", url: "https://notion.so/page", properties: { title: { type: "title", title: [{ plain_text: "Piano App" }] } } }] },
    { id: "01234567-89ab-cdef-0123-456789abcdef" },
  ];
  const fetchImpl = async () => ({ ok: true, json: async () => responses.shift() });
  const service = new KnowledgeService({ configStore: store, fetchImpl });
  const status = await service.configureNotion("module--notion", { token: "ntn_abcdefghijklmnopqrstuvwxyz123456", rootPageId: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(status, {
    configured: true,
    scoped: true,
    label: "Racine : Piano App",
    rootPageId: "0123456789abcdef0123456789abcdef",
    rootPageName: "Piano App",
    integrationName: "Noyau",
  });
  assert.equal(status.token, undefined);
});

test("Notion scope includes descendants but excludes unrelated pages", () => {
  const service = new KnowledgeService({ configStore: new MemoryStore() });
  const root = "0123456789abcdef0123456789abcdef";
  const child = "1123456789abcdef0123456789abcdef";
  const grandchild = "2123456789abcdef0123456789abcdef";
  const pages = [
    { id: root, parentId: null },
    { id: child, parentId: root },
    { id: grandchild, parentId: child },
    { id: "3123456789abcdef0123456789abcdef", parentId: null },
  ];
  assert.deepEqual(service.scopedNotionPages(pages, root).map(({ id }) => id), [root, child, grandchild]);
});

test("Notion availablePages returns all shared pages from search", async () => {
  const store = new MemoryStore({ "module--notion": { token: "ntn_12345678901234567890" } });
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      results: [
        { object: "page", id: "11111111-1111-1111-1111-111111111111", properties: { title: { type: "title", title: [{ plain_text: "Root" }] } } },
      ],
    }),
  });
  const service = new KnowledgeService({ configStore: store, fetchImpl });
  const pages = await service.availablePages("module--notion");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].name, "Root");
});
