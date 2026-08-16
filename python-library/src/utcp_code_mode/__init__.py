"""UTCP Code Mode Client Extension.

This package provides a CodeModeUtcpClient that extends the base UtcpClient
with Python code execution capabilities. It allows executing Python code
that can directly call registered tools as functions.

Key Features:
    - Python code execution with tool access
    - Automatic Python type hint generation from JSON schemas
    - Console output capture
    - Tool introspection capabilities
    - Restricted execution for trusted, cooperative code

Usage:
    ```python
    from utcp_code_mode import CodeModeUtcpClient
    
    # Create a code mode client
    client = await CodeModeUtcpClient.create()
    
    # Execute Python code with tool access
    result = await client.call_tool_chain('''
    # Your Python code here
    weather_result = weather.get_current_weather(city="London")
    print(f"Weather in London: {weather_result}")
    return weather_result
    ''')
    
    print("Result:", result["result"])
    print("Logs:", result["logs"])
    ```
"""

from importlib.metadata import PackageNotFoundError, version

from utcp_code_mode.code_mode_utcp_client import CodeModeUtcpClient

# Since this is a client extension rather than a communication protocol,
# we don't need to register with the plugin system in the same way.
# The CodeModeUtcpClient can be used directly by importing it.

__all__ = [
    "CodeModeUtcpClient",
    "__version__",
]

try:
    __version__ = version("code-mode")
except PackageNotFoundError:
    # Source-tree fallback when package metadata is unavailable.
    __version__ = "1.1.0"
