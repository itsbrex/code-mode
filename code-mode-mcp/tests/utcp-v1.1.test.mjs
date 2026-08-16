import test from "node:test";
import assert from "node:assert/strict";

import {
  CallTemplateSerializer,
  CommunicationProtocol,
  Serializer,
  UtcpClient
} from "@utcp/sdk";

const PRIMARY = "code_mode_fixture_primary";
const SECONDARY = "code_mode_fixture_secondary";

function tool(name, protocol) {
  return {
    name,
    description: `${protocol} fixture`,
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    tags: ["fixture"],
    tool_call_template: { call_template_type: protocol }
  };
}

class FixtureProtocol extends CommunicationProtocol {
  calls = [];

  async registerManual(_caller, manualCallTemplate) {
    return {
      manualCallTemplate,
      manual: {
        utcp_version: "1.0.1",
        manual_version: "1.0.0",
        tools: [tool("same_protocol", PRIMARY), tool("other_protocol", SECONDARY)]
      },
      success: true,
      errors: []
    };
  }

  async deregisterManual() {}

  async callTool(_caller, toolName, toolArgs) {
    this.calls.push({ toolName, toolArgs });
    return { ok: true };
  }

  async *callToolStreaming() {}
}

class FixtureCallTemplateSerializer extends Serializer {
  toDict(value) {
    return { ...value };
  }

  validateDict(value) {
    if (value?.call_template_type !== PRIMARY) {
      throw new Error(`Expected ${PRIMARY} call template`);
    }
    return { ...value };
  }
}

test("UTCP v1.1 filters mixed-protocol tools unless allowlist opts in", async (t) => {
  const primary = new FixtureProtocol();
  const secondary = new FixtureProtocol();
  const previousPrimary = CommunicationProtocol.communicationProtocols[PRIMARY];
  const previousSecondary = CommunicationProtocol.communicationProtocols[SECONDARY];
  CommunicationProtocol.communicationProtocols[PRIMARY] = primary;
  CommunicationProtocol.communicationProtocols[SECONDARY] = secondary;
  CallTemplateSerializer.registerCallTemplate(
    PRIMARY,
    new FixtureCallTemplateSerializer(),
    true
  );
  t.after(() => {
    if (previousPrimary) CommunicationProtocol.communicationProtocols[PRIMARY] = previousPrimary;
    else delete CommunicationProtocol.communicationProtocols[PRIMARY];
    if (previousSecondary) CommunicationProtocol.communicationProtocols[SECONDARY] = previousSecondary;
    else delete CommunicationProtocol.communicationProtocols[SECONDARY];
  });

  const client = await UtcpClient.create(process.cwd(), { manual_call_templates: [] });
  t.after(async () => client.close());

  const defaultResult = await client.registerManual({
    name: "default_filter",
    call_template_type: PRIMARY
  });
  assert.deepEqual(
    defaultResult.manual.tools.map((item) => item.name),
    ["default_filter.same_protocol"]
  );

  const mixedResult = await client.registerManual({
    name: "mixed_allowed",
    call_template_type: PRIMARY,
    allowed_communication_protocols: [PRIMARY, SECONDARY]
  });
  assert.deepEqual(
    mixedResult.manual.tools.map((item) => item.name),
    ["mixed_allowed.same_protocol", "mixed_allowed.other_protocol"]
  );

  await client.config.tool_repository.saveManual(
    { name: "mixed_allowed", call_template_type: PRIMARY },
    mixedResult.manual
  );
  await assert.rejects(
    () => client.callTool("mixed_allowed.other_protocol", {}),
    /not allowed by manual 'mixed_allowed'/
  );
  assert.equal(secondary.calls.length, 0);
});
