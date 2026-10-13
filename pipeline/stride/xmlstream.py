"""Streaming helpers for export.xml.

The file can be several GB. We iterparse 'end' events and only clear an element
once it is a direct child of <HealthData> (so nested MetadataEntry and
WorkoutStatistics children are still attached when their parent is handled).
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator

from lxml import etree

TOP = {
    "Record", "Workout", "ActivitySummary", "Correlation", "ExportDate", "Me",
    "ClinicalRecord", "Audiogram", "VisionPrescription",
}


def iter_top(path: Path) -> Iterator[etree._Element]:
    ctx = etree.iterparse(
        str(path), events=("end",), huge_tree=True, resolve_entities=False,
        load_dtd=False, no_network=True, recover=True,
    )
    for _, elem in ctx:
        parent = elem.getparent()
        if parent is None or parent.tag != "HealthData":
            continue
        yield elem
        elem.clear(keep_tail=False)
        while elem.getprevious() is not None:
            del parent[0]
    del ctx
