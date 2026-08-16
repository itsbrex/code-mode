"""Package metadata contract tests."""

from pathlib import Path
import tomllib

import utcp_code_mode


def test_runtime_version_and_project_urls_match_package_metadata():
    project_root = Path(__file__).resolve().parents[1]
    metadata = tomllib.loads((project_root / "pyproject.toml").read_text())
    project = metadata["project"]

    assert utcp_code_mode.__version__ == project["version"]
    assert project["urls"] == {
        "Homepage": "https://github.com/universal-tool-calling-protocol/code-mode",
        "Source": "https://github.com/universal-tool-calling-protocol/code-mode/tree/main/python-library",
        "Issues": "https://github.com/universal-tool-calling-protocol/code-mode/issues",
    }
