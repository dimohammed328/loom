"""Loom — a markdown-based, hierarchy-agnostic project management system.

Public surface:

    >>> from loom import Loom
    >>> loom = Loom()                        # uses $LOOM_DIR
    >>> project = loom.create_project("acme", title="Acme")
    >>> epic = project.create_epic(title="OAuth")
"""

from .api import Loom
from .deps import ItemRef
from .errors import (
    CycleError,
    Drift,
    Duplicate,
    InvalidQualifiedId,
    LoomError,
    NotFound,
    ReservedName,
    ValidationError,
)
from .ids import QualifiedId, parse_qid
from .items import Epic, Item, Project, Story, Task

__version__ = "0.1.0"

__all__ = [
    "CycleError",
    "Drift",
    "Duplicate",
    "Epic",
    "InvalidQualifiedId",
    "Item",
    "ItemRef",
    "Loom",
    "LoomError",
    "NotFound",
    "Project",
    "QualifiedId",
    "ReservedName",
    "Story",
    "Task",
    "ValidationError",
    "parse_qid",
]
