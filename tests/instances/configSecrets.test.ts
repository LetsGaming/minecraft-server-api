import { describe, it, expect } from "vitest";
import {
  REDACTED,
  changedProtectedKeys,
  parseJavaProperties,
  redactSecrets,
  restoreSecrets,
} from "../../src/instances/configSecrets.js";

describe("Properties grammar", () => {
  it.each([
    ["whitespace separator", "online-mode=true\nonline-mode false\n"],
    ["tab separator", "online-mode=true\nonline-mode\tfalse\n"],
    ["colon separator", "online-mode=true\nonline-mode:false\n"],
    ["colon with spaces", "online-mode=true\nonline-mode : false\n"],
    ["unicode escape in the key", "online-mode=true\nonline\\u002dmode=false\n"],
    ["escaped character in the key", "online-mode=true\nonline\\-mode=false\n"],
    ["continued line", "online-mode=true\nonline-mode=\\\n    false\n"],
    ["continuation after the key", "online-mode=true\nonline-mode\\\n   =false\n"],
    ["leading whitespace", "online-mode=true\n   \tonline-mode=false\n"],
    ["CRLF endings", "online-mode=true\r\nonline-mode false\r\n"],
    ["lone CR endings", "online-mode=true\ronline-mode false\r"],
  ])("sees the later override: %s", (_label, after) => {
    expect(changedProtectedKeys("online-mode=true\n", after)).toEqual(["online-mode"]);
  });

  it("lets the last duplicate win", () => {
    const props = parseJavaProperties("a=1\na=2\n");
    expect(props.get("a")).toBe("2");
    expect(changedProtectedKeys("online-mode=true\n", "online-mode=false\nonline-mode=true\n")).toEqual([]);
  });

  it("skips comments and does not continue them", () => {
    const props = parseJavaProperties("# a=1 \\\nb=2\n! c=3\n");
    expect([...props.keys()]).toEqual(["b"]);
  });

  it("reads escapes in values", () => {
    expect(parseJavaProperties("motd=a\\tb\\u0041\\\\\n").get("motd")).toBe("a\tbA\\");
  });

  it("keeps an empty value for a bare key", () => {
    expect(parseJavaProperties("flag\nother=1\n").get("flag")).toBe("");
  });

  it("flags a protected key that disappears or appears", () => {
    expect(changedProtectedKeys("online-mode=true\n", "motd=x\n")).toEqual(["online-mode"]);
    expect(changedProtectedKeys("motd=x\n", "white-list=false\n")).toEqual(["white-list"]);
  });
});

describe("redaction by format", () => {
  const seen = (text: string) => text.includes("hunter2");

  it.each([
    ["properties", "rcon.password hunter2\nmotd=hi\n"],
    ["properties", "rcon.password:hunter2\n"],
    ["properties", "rcon\\u002epassword=hunter2\n"],
    ["properties", "rcon.password=hunter\\\n  2 hunter2\n"],
    ["json", '{"db":{"password":"hunter2"}}'],
    ["json", '{"a":[{"apiKey":"hunter2"}],"b":1}'],
    ["json", '{ "credentials": { "user": "x", "pw": "hunter2" } }'],
    ["json", '{"token":hunter2}'],
    ["json5", "{ // note\n  secret: 'hunter2',\n}"],
    ["toml", 'db = { user = "a", password = "hunter2" }\n'],
    ["toml", "[credentials]\nuser = \"a\"\nvalue = \"hunter2\"\n"],
    ["toml", 'api_key = """\nhunter2"""\n'],
    ["toml", 'passwords = ["hunter2", "hunter2"]\n'],
    ["yaml", "token: |\n  hunter2\n  more\nother: 1\n"],
    ["yaml", "db: { user: a, password: hunter2 }\n"],
    ["yaml", "secrets:\n  - hunter2\n  - name: hunter2\n"],
    ["yaml", "# password: hunter2\n"],
    ["cfg", "S:password=hunter2\n"],
    ["ini", "[db]\npassword = hunter2\n"],
    ["conf", 'jdbc = "mysql://root:hunter2@db:3306/x"\n'],
    ["text", "url=https://user:hunter2@example.org/path\n"],
  ])("hides the secret in %s: %j", (format, text) => {
    const shown = redactSecrets(text, format);
    expect(seen(shown)).toBe(false);
    expect(shown).toContain(REDACTED);
    expect(restoreSecrets(shown, text, format)).toBe(text);
  });

  it("leaves non-secret content alone", () => {
    const yaml = "name: x\nlist:\n  - a\n  - b\nenabled: true\n";
    expect(redactSecrets(yaml, "yaml")).toBe(yaml);
    const json = '{"password":"","token":"","ok":true,"password-enabled":false}';
    expect(redactSecrets(json, "json")).toBe(json);
    const toml = "[server]\nport = 1\n";
    expect(redactSecrets(toml, "toml")).toBe(toml);
  });

  it("keeps the quote style of a quoted value", () => {
    expect(redactSecrets('BotToken: "abc"\n', "yaml")).toBe(`BotToken: "${REDACTED}"\n`);
    expect(redactSecrets("password = 'abc'\n", "toml")).toBe(`password = '${REDACTED}'\n`);
  });

  it("keeps the rest of a minified document intact", () => {
    const json = '{"a":1,"nested":{"clientSecret":"s","keep":[1,2]},"b":"x"}';
    expect(redactSecrets(json, "json")).toBe(
      `{"a":1,"nested":{"clientSecret":"${REDACTED}","keep":[1,2]},"b":"x"}`,
    );
  });

  it("hides only the password of a credentialed URL", () => {
    expect(redactSecrets("u=redis://bob:s3cret@host:6379/0\n", "properties")).toBe(
      `u=redis://bob:${REDACTED}@host:6379/0\n`,
    );
  });

  it("never throws on malformed input", () => {
    for (const text of ['{"a": [1, {', "[[x\n= =\n", "key: |\n", '"', "{'", "a = '''", "\\"]) {
      for (const f of ["json", "toml", "yaml", "properties", "cfg", "text"]) {
        expect(() => redactSecrets(text, f)).not.toThrow();
      }
    }
  });
});

describe("restoring secrets", () => {
  it("restores each repeated key in order", () => {
    const json = '{"a":{"token":"t1"},"b":{"token":"t2"}}';
    const shown = redactSecrets(json, "json");
    expect(restoreSecrets(shown, json, "json")).toBe(json);
  });

  it("keeps a value the client replaced", () => {
    const text = "rcon.password hunter2\nmotd=a\n";
    const edited = redactSecrets(text, "properties").replace(REDACTED, "newpass");
    expect(restoreSecrets(edited, text, "properties")).toBe("rcon.password newpass\nmotd=a\n");
  });

  it("refuses a placeholder with no original behind it", () => {
    expect(restoreSecrets(`{"token":"${REDACTED}"}`, '{"other":1}', "json")).toBeNull();
    expect(restoreSecrets(`motd=${REDACTED}\n`, "motd=a\n", "properties")).toBeNull();
  });

  it("refuses a placeholder moved under another key", () => {
    const current = '{"token":"a","password":"b"}';
    expect(restoreSecrets(`{"token":"${REDACTED}","note":"${REDACTED}"}`, current, "json")).toBeNull();
  });

  it("restores an unquoted JSON secret that was shown as a string", () => {
    const json = '{"token":12345}';
    const shown = redactSecrets(json, "json");
    expect(shown).toBe(`{"token":"${REDACTED}"}`);
    expect(restoreSecrets(shown, json, "json")).toBe(json);
  });

  it("restores a YAML block scalar", () => {
    const yaml = "token: |\n  line1\n  line2\nnext: 1\n";
    const shown = redactSecrets(yaml, "yaml");
    expect(shown).toBe(`token: |\n  ${REDACTED}\nnext: 1\n`);
    expect(restoreSecrets(shown, yaml, "yaml")).toBe(yaml);
  });
});
