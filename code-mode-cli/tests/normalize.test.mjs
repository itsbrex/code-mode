import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUtcpConfig, inferTransport } from '../dist/src/normalize.js';

test('infers mcp transport from the server shape', () => {
  assert.equal(inferTransport({ command: 'uv', args: ['run', 'x'] }), 'stdio');
  assert.equal(inferTransport({ url: 'https://example.com/mcp' }), 'http');
  assert.equal(inferTransport({ url: 'https://example.com/sse', type: 'sse' }), 'http');
  assert.equal(inferTransport({}), undefined);
});

test('fills transport and auth_tools, reporting each change', () => {
  const raw = {
    manual_call_templates: [
      {
        name: 'keep',
        call_template_type: 'mcp',
        config: { mcpServers: { keep: { url: 'https://keep.md/mcp' } } },
        auth: { auth_type: 'oauth2_user', access_token: '${KEEP_OAUTH_TOKEN}' },
      },
      {
        name: 'keep_rest',
        call_template_type: 'http',
        url: 'https://keep.md/openapi.json',
        auth: {
          auth_type: 'api_key',
          api_key: 'Bearer ${KEEP_API_KEY}',
          var_name: 'Authorization',
          location: 'header',
        },
      },
    ],
  };
  const { config, changes } = normalizeUtcpConfig(raw);

  assert.equal(config.manual_call_templates[0].config.mcpServers.keep.transport, 'http');
  // auth alone authenticates only the spec fetch; tools need auth_tools.
  assert.deepEqual(
    config.manual_call_templates[1].auth_tools,
    raw.manual_call_templates[1].auth,
  );
  assert.equal(changes.length, 2);
  // input untouched
  assert.equal(raw.manual_call_templates[0].config.mcpServers.keep.transport, undefined);
  assert.equal(raw.manual_call_templates[1].auth_tools, undefined);
});

test('leaves explicit values and unrelated configs alone', () => {
  const raw = {
    manual_call_templates: [
      {
        name: 'm',
        call_template_type: 'mcp',
        config: { mcpServers: { m: { command: 'x', transport: 'stdio' } } },
      },
      { name: 'open', call_template_type: 'http', url: 'https://example.com/openapi.json' },
      {
        name: 'custom',
        call_template_type: 'http',
        url: 'https://example.com/openapi.json',
        auth: { auth_type: 'api_key', api_key: 'k', var_name: 'X-Key', location: 'header' },
        auth_tools: { auth_type: 'api_key', api_key: 'other', var_name: 'X-Key', location: 'header' },
      },
    ],
  };
  const { config, changes } = normalizeUtcpConfig(raw);
  assert.deepEqual(changes, []);
  assert.equal(config.manual_call_templates[2].auth_tools.api_key, 'other');
});

test('tolerates a config with no manuals', () => {
  assert.deepEqual(normalizeUtcpConfig({}).changes, []);
  assert.deepEqual(normalizeUtcpConfig({ manual_call_templates: 'nope' }).changes, []);
});
