"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const fs = require("fs");
const path = require("path");

const { parseVarsFile } = require("../src/parseVars");

describe("parseVarsFile", () => {
  function writeTmp(content) {
    const file = path.join(os.tmpdir(), `vars-${Date.now()}.txt`);
    fs.writeFileSync(file, content);
    return file;
  }

  it("parses unquoted values", () => {
    const f = writeTmp("SERVER_PATH=/opt/mc\nINSTANCE_NAME=survival\n");
    const vars = parseVarsFile(f);
    assert.equal(vars["SERVER_PATH"], "/opt/mc");
    assert.equal(vars["INSTANCE_NAME"], "survival");
  });

  it("parses quoted values", () => {
    const f = writeTmp('API_SERVER_KEY="mysecretkey"\n');
    const vars = parseVarsFile(f);
    assert.equal(vars["API_SERVER_KEY"], "mysecretkey");
  });

  it("handles CRLF line endings", () => {
    const f = writeTmp("USE_RCON=true\r\nRCON_PORT=25575\r\n");
    const vars = parseVarsFile(f);
    assert.equal(vars["USE_RCON"], "true");
    assert.equal(vars["RCON_PORT"], "25575");
  });

  it("handles LF line endings", () => {
    const f = writeTmp("USE_RCON=false\nRCON_PORT=25576\n");
    const vars = parseVarsFile(f);
    assert.equal(vars["USE_RCON"], "false");
  });

  it("skips blank lines and comments", () => {
    const f = writeTmp("# a comment\n\nSERVER_PATH=/mc\n");
    const vars = parseVarsFile(f);
    assert.equal(Object.keys(vars).length, 1);
    assert.equal(vars["SERVER_PATH"], "/mc");
  });
});
