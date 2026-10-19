import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildVariableAliases,
  namespacedKey,
  parseDotenv
} from "../dist/utcp-variable-aliases.js";

const config = {
  load_variables_from: [{ variable_loader_type: "dotenv", env_file_path: ".env" }],
  manual_call_templates: [
    {
      name: "keep",
      call_template_type: "mcp",
      config: { mcpServers: { keep: { url: "https://keep.md/mcp", transport: "http" } } },
      auth: { auth_type: "oauth2_user", access_token: "${KEEP_OAUTH_TOKEN}" }
    },
    {
      name: "keep_rest",
      call_template_type: "http",
      url: "https://keep.md/openapi.json",
      auth: {
        auth_type: "api_key",
        api_key: "Bearer ${KEEP_API_KEY}",
        var_name: "Authorization",
        location: "header"
      }
    }
  ]
};

async function workspace(envText) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "utcp-alias-"));
  if (envText !== undefined) await fs.writeFile(path.join(dir, ".env"), envText);
  return dir;
}

test("namespacedKey doubles underscores in the manual name", () => {
  assert.equal(namespacedKey("keep", "TOK"), "keep_TOK");
  assert.equal(namespacedKey("keep_rest", "KEY"), "keep__rest_KEY");
});

test("parseDotenv handles export, comments and quotes", () => {
  assert.deepEqual(parseDotenv('# c\nexport A=1\nB="two"\nC=\'three\'\nbad\n'), {
    A: "1", B: "two", C: "three"
  });
});

test("aliases bare .env names to the namespaced keys UTCP reads", async () => {
  const dir = await workspace("KEEP_OAUTH_TOKEN=tok\nKEEP_API_KEY=key\n");
  const { variables, notes } = await buildVariableAliases(config, dir);
  assert.deepEqual(variables, { keep_KEEP_OAUTH_TOKEN: "tok", keep__rest_KEEP_API_KEY: "key" });
  assert.ok(notes.every((n) => !n.includes("tok") && !n.includes("key")));
});

test("an existing namespaced value is never overridden", async () => {
  const dir = await workspace("KEEP_OAUTH_TOKEN=bare\nkeep_KEEP_OAUTH_TOKEN=isolated\n");
  const { variables } = await buildVariableAliases(config, dir);
  assert.equal(variables.keep_KEEP_OAUTH_TOKEN, undefined);
});

test("no manuals, no aliases", async () => {
  const dir = await workspace("A=1\n");
  assert.deepEqual((await buildVariableAliases({}, dir)).notes, []);
});
