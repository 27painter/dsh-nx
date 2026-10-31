"""Filesystem boundary for NX MCP file operations."""


from pathlib import Path, PureWindowsPath


class WorkspaceViolation(ValueError):
    """Raised when a requested path escapes the configured workspace."""


class Workspace:
    def __init__(self, root: "str | Path") -> "None":
        self.root = Path(root).resolve()

    def resolve(self, relative_path: "str") -> "Path":
        requested = Path(relative_path)
        if requested.is_absolute() or PureWindowsPath(relative_path).anchor:
            raise WorkspaceViolation("Path must stay inside the configured workspace")

        return self.ensure_inside(self.root / requested)

    def ensure_inside(self, path: "str | Path") -> "Path":
        resolved = Path(path).resolve()
        # Path.is_relative_to() is 3.9+; NX 12 embeds 3.6, where relative_to()
        # raises ValueError instead.
        try:
            resolved.relative_to(self.root)
        except ValueError:
            raise WorkspaceViolation("Path must stay inside the configured workspace")
        return resolved
