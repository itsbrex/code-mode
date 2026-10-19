# `@utcp/http`: an OpenAPI manual with `auth` and no `auth_tools` calls every tool unauthenticated

Status: worked around locally (see `utcp-normalize.ts` in this package and
`src/normalize.ts` in `code-mode-cli`); not yet reported upstream.
Observed on `@utcp/http@1.1.11` (the version both this bridge and
`npx @utcp/code-mode-cli@0.1.1` resolve), 2026-09-22.

## Symptom

An `http` manual pointed at an OpenAPI spec, with credentials in `auth`:

```json
{
  "name": "keep_rest",
  "call_template_type": "http",
  "http_method": "GET",
  "url": "https://keep.md/openapi.json",
  "content_type": "application/json",
  "auth": {
    "auth_type": "api_key",
    "api_key": "Bearer ${KEEP_API_KEY}",
    "var_name": "Authorization",
    "location": "header"
  }
}
```

registers cleanly — `Successfully registered manual 'keep_rest' with 83 tools.`
— and then every call fails:

```
Request failed with status code 401   url: 'https://keep.md/api/me'   error: 'unauthorized'
```

The same key over curl returns 200:

```
curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEEP_API_KEY" https://keep.md/api/me
200
```

So the credential is good, and the failure reads like a revoked key rather than
a config problem. Nothing in the logs mentions auth.

## Reproduction without a real credential

Serve a two-line OpenAPI spec with `bearerAuth` from `127.0.0.1:8899`, log the
`Authorization` header of every request, point an `http` manual at it with a
fake key, and call the generated tool:

```
PATH=/openapi.json AUTH='Bearer FAKEKEY-abc123'     <- the spec fetch is authenticated
PATH=/api/me       AUTH=None                        <- the generated tool call is not
```

Adding `"auth_tools": { ...same block... }` to the manual changes the second
line to `AUTH='Bearer FAKEKEY-abc123'` and the call succeeds.

## Root cause

`auth` and `auth_tools` feed two different paths, and only the first is
obvious:

1. `auth` authenticates the request that **fetches the spec**.
2. `auth_tools` is handed to `OpenApiConverter` and becomes the auth of **each
   generated tool**:

   ```js
   const converter = new OpenApiConverter(responseData, {
     specUrl: httpCallTemplate.url,
     callTemplateName: httpCallTemplate.name,
     authTools: httpCallTemplate.auth_tools,   // <- `auth` is never consulted here
     headers: httpCallTemplate.headers
   });
   ```

`_extractAuth()` then decides per operation:

```js
_extractAuth(operation) {
  if (this.auth_tools === null) return void 0;      // omitted === "tools get no auth"
  ...
  if (this._isAuthCompatible(openapiAuth, this.auth_tools)) return this.auth_tools;
  return openapiAuth;                                // spec-derived placeholder, e.g. ${API_KEY_0}
}
```

and `HttpCallTemplateSchema` turns an omitted `auth_tools` into exactly that
`null`:

```js
auth_tools: AuthSchema.nullable().optional().transform((val) => {
  if (val === null || val === void 0) return null;
  ...
})
```

So **omitting `auth_tools` is indistinguishable from explicitly disabling tool
auth**, and the manual's own `auth` block — the only credential the author
supplied — is silently unused for calls. The manual still registers, because
the spec fetch (the one request `auth` does cover) succeeds.

## Suggested upstream fix

Preferred — inherit `auth` when `auth_tools` was not specified, while keeping
an explicit `null` as the opt-out. This needs the schema to stop collapsing
`undefined` into `null`:

```diff
-  auth_tools: AuthSchema.nullable().optional().transform((val) => {
-    if (val === null || val === void 0) return null;
+  auth_tools: AuthSchema.nullable().optional().transform((val) => {
+    if (val === void 0) return void 0;   // "not specified" — inherit from `auth`
+    if (val === null) return null;       // explicit opt-out — tools stay unauthenticated
```

```diff
   const converter = new OpenApiConverter(responseData, {
     specUrl: httpCallTemplate.url,
     callTemplateName: httpCallTemplate.name,
-    authTools: httpCallTemplate.auth_tools,
+    authTools: httpCallTemplate.auth_tools === undefined
+      ? httpCallTemplate.auth
+      : httpCallTemplate.auth_tools,
     headers: httpCallTemplate.headers
   });
```

`_extractAuth()` already does the right thing from there: `_isAuthCompatible()`
compares the inherited block against the spec's security scheme and uses it
when the `auth_type` / `var_name` / `location` line up, falling back to the
spec-derived placeholder otherwise.

Minimum viable alternative, if inheritance is considered a breaking change:
log a warning at registration when a manual has `auth`, no `auth_tools`, and a
spec that declares security — i.e. when every generated tool is about to be
called unauthenticated.

## What we do in the meantime

Both entry points normalize the config before it reaches the SDK, mirroring
`auth` into `auth_tools` when only `auth` is present (and filling in a missing
mcp `transport`, which fails the same way — loudly, but with a message that
does not name the config):

- `code-mode-mcp/utcp-normalize.ts` — used by `initializeUtcpClient()` and by
  the `register_manual` tool.
- `code-mode-cli/src/normalize.ts` — used by `createClient()`.

Both print what they filled in, e.g.

```
[code-mode] normalized /path/.utcp_config.json: keep: mcpServers.keep.transport="http"; keep_rest: auth_tools mirrored from auth
```

If upstream declines the change, the alternative is a `patches/` entry like the
existing `@utcp+mcp+1.1.7.patch`, which would mean pinning `@utcp/http` to an
exact version in `package.json` (it is `^1.1.11` today).
