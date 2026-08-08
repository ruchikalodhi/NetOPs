"""
routers/discovery.py
─────────────────────
API endpoints for Network Discovery, Device Import, and Topology.

Endpoints:
  POST /api/devices/{device_id}/discover          - trigger async discovery
  GET  /api/devices/{device_id}/discover/status   - poll progress
  POST /api/devices/import-discovered             - import selected neighbors
  GET  /api/topology                              - full topology graph data
"""

import uuid
import logging
import threading
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db.database import get_config_db
from db import models
from services.network_discovery import (
    discover_neighbors,
    import_discovered_devices,
    get_topology_data,
    get_discovery_status,
)

logger = logging.getLogger("discovery_router")
router = APIRouter()


# ── Pydantic schemas ─────────────────────────────────────────────────────────

class DiscoverRequest(BaseModel):
    depth: int = 1          # 1 = direct neighbors, 2 = +1 hop, 0 = unlimited


class NeighborImportItem(BaseModel):
    hostname: str
    ip: str
    platform: Optional[str] = "Unknown"
    description: Optional[str] = ""
    local_port: Optional[str] = ""
    remote_port: Optional[str] = ""
    chassis_id: Optional[str] = ""
    protocol: Optional[str] = "LLDP"
    device_type_hint: Optional[str] = "Unknown"
    status: Optional[str] = "New"


class ImportDiscoveredRequest(BaseModel):
    seed_device_id: int
    neighbors: List[NeighborImportItem]


# ── Helper ───────────────────────────────────────────────────────────────────

def _run_discovery_task(device_id: int, depth: int, task_id: str):
    """Runs in a background thread."""
    try:
        discover_neighbors(device_id=device_id, depth=depth, task_id=task_id)
    except Exception as e:
        logger.error(f"[DISCOVERY TASK] Error in background task {task_id}: {e}")


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/api/devices/{device_id}/discover")
def trigger_discovery(
    device_id: int,
    req: DiscoverRequest,
    db: Session = Depends(get_config_db),
):
    """
    Kick off an async LLDP/CDP neighbor discovery against the specified device.
    Returns a task_id that can be polled for progress/results.
    """
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    # Validate SNMP config exists
    has_snmp = (
        (device.snmp_version == "v2c" and device.snmp_community_encrypted) or
        (device.snmp_version == "v3" and device.snmp_username)
    )
    if not has_snmp:
        raise HTTPException(
            status_code=400,
            detail="Device has no SNMP credentials configured. "
                   "Please update the device with SNMP settings before running discovery."
        )

    depth = max(0, min(req.depth, 5))  # clamp 0-5; 0 = unlimited (up to 5 internally)
    task_id = str(uuid.uuid4())

    # Launch discovery in a daemon thread (non-blocking)
    t = threading.Thread(
        target=_run_discovery_task,
        args=(device_id, depth, task_id),
        daemon=True,
        name=f"discovery-{task_id[:8]}",
    )
    t.start()

    return {
        "success": True,
        "task_id": task_id,
        "device_id": device_id,
        "device_name": device.name,
        "depth": depth,
        "message": f"Discovery started for {device.name}. Poll /api/devices/{device_id}/discover/status/{task_id}",
    }


@router.get("/api/devices/{device_id}/discover/status/{task_id}")
def get_discovery_task_status(device_id: int, task_id: str):
    """
    Poll discovery task status. Returns progress and results when complete.
    """
    status = get_discovery_status(task_id)
    if status is None:
        raise HTTPException(status_code=404, detail="Task not found or expired")
    return status


@router.post("/api/devices/import-discovered")
def import_discovered(
    req: ImportDiscoveredRequest,
    db: Session = Depends(get_config_db),
):
    """
    Import selected discovered neighbor devices into inventory.
    Credentials are copied from the seed device.
    """
    seed = db.query(models.Device).filter(models.Device.id == req.seed_device_id).first()
    if not seed:
        raise HTTPException(status_code=404, detail="Seed device not found")

    # Filter to only "New" neighbors (skip already registered)
    to_import = [n.dict() for n in req.neighbors if n.status != "Already Registered"]

    if not to_import:
        return {"success": True, "imported": 0, "skipped": len(req.neighbors), "errors": []}

    result = import_discovered_devices(
        neighbors=to_import,
        seed_device_id=req.seed_device_id,
        db=db,
    )
    return result


@router.get("/api/topology")
def get_topology(db: Session = Depends(get_config_db)):
    """
    Return all devices as nodes and all discovered links as edges for topology visualization.
    """
    return get_topology_data(db)
