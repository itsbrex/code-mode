"""Tests for the CodeModeUtcpClient."""

import pytest
import pytest_asyncio
import asyncio
import json
from typing import Dict, Any
from unittest.mock import Mock, AsyncMock, patch

from utcp_code_mode import CodeModeUtcpClient
from utcp.data.tool import Tool, JsonSchema
from utcp.data.call_template import CallTemplate


class MockCallTemplate(CallTemplate):
    """Mock call template for testing."""
    def __init__(self, name="test", call_template_type="http"):
        super().__init__(name=name, call_template_type=call_template_type)


@pytest.fixture
def mock_base_client():
    """Create a mock base client for testing."""
    mock_client = Mock()
    mock_client.config = Mock()
    mock_client.root_dir = "/test/root"
    
    # Mock tool repository
    mock_repo = Mock()
    mock_repo.get_tools = AsyncMock(return_value=[])
    mock_client.config.tool_repository = mock_repo
    
    # Mock the base client methods
    mock_client.register_manual = AsyncMock()
    mock_client.register_manuals = AsyncMock()
    mock_client.deregister_manual = AsyncMock()
    mock_client.call_tool = AsyncMock()
    mock_client.call_tool_streaming = AsyncMock()
    mock_client.search_tools = AsyncMock()
    mock_client.get_required_variables_for_manual_and_tools = AsyncMock()
    mock_client.get_required_variables_for_registered_tool = AsyncMock()
    
    return mock_client


@pytest.fixture
def code_mode_client(mock_base_client):
    """Create a CodeModeUtcpClient instance for testing."""
    return CodeModeUtcpClient(mock_base_client)


@pytest.fixture
def sample_tool():
    """Create a sample tool for testing."""
    input_schema = JsonSchema(
        type="object",
        properties={
            "city": JsonSchema(type="string", description="City name"),
            "country": JsonSchema(type="string", description="Country code")
        },
        required=["city"]
    )
    
    output_schema = JsonSchema(
        type="object",
        properties={
            "temperature": JsonSchema(type="number", description="Temperature in Celsius"),
            "description": JsonSchema(type="string", description="Weather description")
        }
    )
    
    return Tool(
        name="weather.get_current_weather",
        description="Get current weather for a city",
        inputs=input_schema,
        outputs=output_schema,
        tags=["weather", "api"],
        tool_call_template=MockCallTemplate()
    )


class TestCodeModeUtcpClient:
    """Test cases for CodeModeUtcpClient."""

    def test_sanitize_identifier(self, code_mode_client):
        """Test identifier sanitization."""
        client = code_mode_client
        
        # Test normal identifier
        assert client._sanitize_identifier("normal_name") == "normal_name"
        
        # Test identifier with special characters
        assert client._sanitize_identifier("test-name.with@special") == "test_name_with_special"
        
        # Test identifier starting with number
        assert client._sanitize_identifier("123test") == "_123test"
        
        # Test empty string
        assert client._sanitize_identifier("") == ""

    def test_tool_to_python_interface(self, code_mode_client, sample_tool):
        """Test converting tool to Python interface."""
        client = code_mode_client
        
        interface = client.tool_to_python_interface(sample_tool)
        
        # Check that it contains expected elements
        assert "weather" in interface  # namespace
        assert "get_current_weather" in interface  # tool name
        assert "TypedDict" in interface
        assert "Get current weather for a city" in interface  # description
        assert "weather, api" in interface  # tags
        assert "weather.get_current_weather" in interface  # access pattern (no await)
        
        # Check caching
        interface2 = client.tool_to_python_interface(sample_tool)
        assert interface == interface2

    @pytest.mark.asyncio
    async def test_get_all_tools_python_interfaces(self, code_mode_client, sample_tool, mock_base_client):
        """Test getting all tool interfaces."""
        client = code_mode_client
        base_client = mock_base_client
        
        # Mock the get_tools method
        base_client.config.tool_repository.get_tools.return_value = [sample_tool]
        
        interfaces = await client.get_all_tools_python_interfaces()
        
        # Check that it contains expected imports and content
        assert "from typing import TypedDict, Any, List, Dict, Optional, Union" in interfaces
        assert "import asyncio" in interfaces
        assert "weather" in interfaces
        assert "get_current_weather" in interfaces

    @pytest.mark.asyncio
    async def test_call_tool_chain_simple_execution(self, code_mode_client, mock_base_client):
        """Test simple code execution without tools."""
        client = code_mode_client
        base_client = mock_base_client
        
        base_client.config.tool_repository.get_tools.return_value = []
        
        code = """
value = 2 + 2
print(f"The answer is {value}")
return value
"""
        
        result = await client.call_tool_chain(code)
        
        assert result["result"] == 4
        # Logs should now capture print output with RestrictedPython
        assert isinstance(result["logs"], list)
        assert len(result["logs"]) > 0
        assert "The answer is 4" in result["logs"][0]

    @pytest.mark.asyncio
    async def test_call_tool_chain_with_tool_calls(self, code_mode_client, mock_base_client, sample_tool):
        """Test code execution with tool calls."""
        client = code_mode_client
        base_client = mock_base_client
        
        # Setup mocks
        base_client.config.tool_repository.get_tools.return_value = [sample_tool]
        base_client.call_tool.return_value = {"temperature": 20, "description": "Sunny"}
        
        code = """
# Call the weather tool - now synchronous!
weather_data = weather.get_current_weather(city="London")
print(f"Weather result: {weather_data}")
return weather_data
"""
        
        # Tool calls should now work with RestrictedPython in same process
        result = await client.call_tool_chain(code)
        
        # Tool calls should work now
        assert result["result"] == {"temperature": 20, "description": "Sunny"}
        # Verify the tool was called with correct arguments
        base_client.call_tool.assert_called_once_with("weather.get_current_weather", {"city": "London"})
        # Verify logs are captured
        assert len(result["logs"]) > 0
        assert "Weather result:" in result["logs"][0]

    @pytest.mark.asyncio
    async def test_call_tool_chain_can_reference_interfaces(self, code_mode_client, mock_base_client, sample_tool):
        """Regression test for issue #24: `interfaces` and `get_tool_interface`
        must be reachable from sandboxed user code. RestrictedPython rejects
        identifiers that start with an underscore at compile time, so the
        previous `__interfaces` / `__get_tool_interface` names were unreachable
        even though the context dict contained them.
        """
        client = code_mode_client
        base_client = mock_base_client

        base_client.config.tool_repository.get_tools.return_value = [sample_tool]

        code = """
own_iface = get_tool_interface("weather.get_current_weather")
return {
    "interfaces_is_str": isinstance(interfaces, str) and len(interfaces) > 0,
    "iface_mentions_tool": "get_current_weather" in (own_iface or ""),
}
"""

        result = await client.call_tool_chain(code)

        assert result["result"]["interfaces_is_str"] is True
        assert result["result"]["iface_mentions_tool"] is True

    @pytest.mark.asyncio
    async def test_call_tool_chain_error_handling(self, code_mode_client, mock_base_client):
        """Test error handling in code execution."""
        client = code_mode_client
        base_client = mock_base_client
        
        base_client.config.tool_repository.get_tools.return_value = []
        
        code = """
# This will cause an error
return 1 / 0
"""
        
        result = await client.call_tool_chain(code)
        
        assert result["result"] is None
        # Error should now be captured in logs
        assert isinstance(result["logs"], list)
        assert len(result["logs"]) > 0
        assert "ERROR" in result["logs"][0] or "division by zero" in str(result).lower()

    @pytest.mark.asyncio
    async def test_call_tool_chain_timeout(self, code_mode_client, mock_base_client):
        """Test timeout handling.
        
        Note: Python can't forcibly kill threads running synchronous code,
        so infinite loops can't be interrupted. This test verifies that
        the timeout mechanism works for operations that yield control.
        """
        client = code_mode_client
        base_client = mock_base_client
        
        base_client.config.tool_repository.get_tools.return_value = []
        
        # Test with code that takes too long but can be interrupted
        # Use a computation that checks for cancellation
        code = """
# Test timeout with a long-running but interruptible operation
import asyncio
result = []
for i in range(1000000):
    result.append(i * i)
return len(result)
"""
        
        # Test with a very short timeout
        result = await client.call_tool_chain(code, timeout=1)
        
        # The operation should time out
        assert result["result"] is None
        # Timeout error should be captured in logs
        assert isinstance(result["logs"], list)
        assert len(result["logs"]) > 0
        assert "timed out" in result["logs"][0].lower() or "ERROR" in result["logs"][0]

    @pytest.mark.asyncio
    async def test_create_execution_context(self, code_mode_client, sample_tool):
        """Test execution context creation."""
        client = code_mode_client
        logs = []
        context = await client._create_execution_context([sample_tool], logs)
        
        # Check basic utilities are present
        assert "json" in context
        assert "asyncio" in context
        assert "math" in context
        
        # Check that RestrictedPython safe globals are present
        assert "_getattr_" in context
        assert "_print" in context
        
        # Check that dangerous modules are not present in context root
        assert "os" not in context
        assert "sys" not in context
        
        # Check that restricted imports are in place
        assert "__import__" in context
        
        # Check tool-related items
        assert "interfaces" in context
        assert "get_tool_interface" in context
        assert "weather" in context

        # Test the tool interface function
        interface = context["get_tool_interface"]("weather.get_current_weather")
        assert interface is not None
        assert "get_current_weather" in interface

    def test_json_schema_to_python_type_string(self, code_mode_client):
        """Test JSON schema to Python type conversion."""
        client = code_mode_client
        
        # Test string type
        string_schema = JsonSchema(type="string")
        assert client._json_schema_to_python_type_string(string_schema) == "str"
        
        # Test number type
        number_schema = JsonSchema(type="number")
        assert client._json_schema_to_python_type_string(number_schema) == "float"
        
        # Test object type
        object_schema = JsonSchema(
            type="object",
            properties={"name": JsonSchema(type="string")},
            required=["name"]
        )
        result = client._json_schema_to_python_type_string(object_schema)
        assert "TypedDict" in result
        assert "name" in result
        
        # Test array type
        array_schema = JsonSchema(
            type="array",
            items=JsonSchema(type="string")
        )
        assert client._json_schema_to_python_type_string(array_schema) == "List[str]"
        
        # Test enum
        enum_schema = JsonSchema(
            type="string",
            enum=["red", "green", "blue"]
        )
        result = client._json_schema_to_python_type_string(enum_schema)
        assert "Literal" in result
        assert '"red"' in result

    def test_map_json_type_to_python(self, code_mode_client):
        """Test basic type mapping."""
        client = code_mode_client
        
        assert client._map_json_type_to_python("string") == "str"
        assert client._map_json_type_to_python("number") == "float"
        assert client._map_json_type_to_python("integer") == "int"
        assert client._map_json_type_to_python("boolean") == "bool"
        assert client._map_json_type_to_python("null") == "None"
        assert client._map_json_type_to_python("unknown") == "Any"

    @pytest.mark.asyncio
    async def test_delegation_methods(self, code_mode_client, mock_base_client):
        """Test that all abstract methods are properly delegated."""
        client = code_mode_client
        base_client = mock_base_client
        
        call_template = MockCallTemplate()
        
        # Test all delegated methods
        await client.register_manual(call_template)
        base_client.register_manual.assert_called_once_with(call_template)
        
        await client.register_manuals([call_template])
        base_client.register_manuals.assert_called_once_with([call_template])
        
        await client.deregister_manual("test")
        base_client.deregister_manual.assert_called_once_with("test")
        
        await client.call_tool("tool", {"arg": "value"})
        base_client.call_tool.assert_called_once_with("tool", {"arg": "value"})
        
        await client.search_tools("query")
        base_client.search_tools.assert_called_once_with("query", 10, None)
        
        await client.get_required_variables_for_manual_and_tools(call_template)
        base_client.get_required_variables_for_manual_and_tools.assert_called_once_with(call_template)
        
        await client.get_required_variables_for_registered_tool("tool")
        base_client.get_required_variables_for_registered_tool.assert_called_once_with("tool")

    @pytest.mark.asyncio
    async def test_restricted_imports(self, code_mode_client, mock_base_client):
        """Test that dangerous imports are blocked."""
        client = code_mode_client
        base_client = mock_base_client
        
        base_client.config.tool_repository.get_tools.return_value = []
        
        # Test that dangerous imports are blocked
        dangerous_code = """
try:
    import os
    return "Should not reach here - os import succeeded"
except ImportError as e:
    return f"Import blocked: {e}"
"""
        
        result = await client.call_tool_chain(dangerous_code)
        assert "Import blocked" in str(result["result"])
        
        # Test that safe imports work
        safe_code = """
try:
    import json
    import math
    return "Safe imports work"
except ImportError as e:
    return f"Unexpected error: {e}"
"""
        
        result = await client.call_tool_chain(safe_code)
        assert result["result"] == "Safe imports work"

    @pytest.mark.asyncio
    async def test_restricted_builtins(self, code_mode_client, mock_base_client):
        """Test that builtins are properly restricted."""
        client = code_mode_client
        base_client = mock_base_client
        
        base_client.config.tool_repository.get_tools.return_value = []
        
        # Test that safe builtins work
        safe_builtins_code = """
results = []
results.append(len("test"))  # len should work
results.append(str(42))      # str should work
results.append(max([1,2,3])) # max should work
return results
"""
        
        result = await client.call_tool_chain(safe_builtins_code)
        assert result["result"] == [4, "42", 3]

    @pytest.mark.asyncio
    async def test_create_class_method(self, mock_base_client):
        """Test the create class method."""
        base_client = mock_base_client
        
        with patch('utcp.implementations.utcp_client_implementation.UtcpClientImplementation') as mock_impl:
            # Make the create method an AsyncMock to properly handle await
            mock_impl.create = AsyncMock(return_value=base_client)
            
            client = await CodeModeUtcpClient.create("/test/root", {"test": "config"})
            
            assert isinstance(client, CodeModeUtcpClient)
            assert client._base_client == base_client
            mock_impl.create.assert_called_once_with("/test/root", {"test": "config"})

    def test_create_restricted_import(self, code_mode_client):
        """Test RestrictedPython integration and safe globals."""
        client = code_mode_client
        
        # Test that restricted import function works
        restricted_import = client._create_restricted_import()
        
        # Test safe imports work
        json_module = restricted_import('json')
        assert json_module is not None
        
        # Test dangerous imports are blocked
        with pytest.raises(ImportError, match="Import of 'os' is not allowed"):
            restricted_import('os')

    def test_agent_prompt_template(self):
        """Test that the agent prompt template is properly defined."""
        template = CodeModeUtcpClient.AGENT_PROMPT_TEMPLATE
        
        assert isinstance(template, str)
        assert len(template) > 100  # Should be substantial
        assert "CodeModeUtcpClient" in template
        assert "Tool Discovery" in template
        assert "call_tool_chain" in template
        assert "manual.tool" in template
        assert "synchronous" in template  # Should mention tools are synchronous


if __name__ == "__main__":
    pytest.main([__file__])
