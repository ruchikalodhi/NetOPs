"""
services/network_discovery.py
─────────────────────────────
Network discovery orchestration service.

Responsibilities:
  - Decrypt SNMP credentials from the Device model
  - Run LLDP discovery
  - Run CDP discovery (Cisco devices)
  - Merge and deduplicate results
  - Support recursive discovery (depth 1, 2, or unlimited)
  - Loop prevention via visited_devices set
  - Return structured neighbor list

All SNMP operations are performed on the backend only; credentials
are never exposed to the frontend.
"""

import logging
import threading
from typing import List, Dict, Any, Optional, Set
from datetime import datetime

from db.database import ConfigSessionLocal
from db import models
from db.security import decrypt_value
from services.lldp_discovery import discover_lldp_neighbors
from services.cdp_discovery import discover_cdp_neighbors

logger = logging.getLogger("network_discovery")

# ── In-memory store for ongoing discovery tasks ──────────────────────────────
_discovery_results: Dict[str, Dict] = {}
_discovery_lock = threading.Lock()


def get_discovery_status(task_id: str) -> Optional[Dict]:
    with _discovery_lock:
        return _discovery_results.get(task_id)


def _store_result(task_id: str, data: Dict):
    with _discovery_lock:
        _discovery_results[task_id] = data


def _get_snmp_kwargs(device: models.Device) -> Dict:
    """Extract and decrypt SNMP credentials from a Device ORM object."""
    version = device.snmp_version or "v2c"
    return {
        "snmp_version":   version,
        "snmp_port":      device.snmp_port or 161,
        "snmp_timeout":   device.snmp_timeout or 5,
        "snmp_retries":   device.snmp_retries or 1,
        "community":      decrypt_value(device.snmp_community_encrypted) if device.snmp_community_encrypted else "public",
        "snmp_username":  device.snmp_username or "",
        "auth_protocol":  device.snmp_auth_protocol or "",
        "auth_password":  decrypt_value(device.snmp_auth_password_encrypted) if device.snmp_auth_password_encrypted else "",
        "priv_protocol":  device.snmp_priv_protocol or "",
        "priv_password":  decrypt_value(device.snmp_priv_password_encrypted) if device.snmp_priv_password_encrypted else "",
    }


def _discover_single_host(host: str, snmp_kwargs: Dict) -> List[Dict[str, Any]]:
    """
    Run LLDP + CDP discovery on a single host and return deduplicated results.
    """
    neighbors = []

    # LLDP
    try:
        lldp = discover_lldp_neighbors(host=host, **snmp_kwargs)
        neighbors.extend(lldp)
    except Exception as e:
        logger.warning(f"[DISCOVERY] LLDP failed on {host}: {e}")

    # CDP
    try:
        cdp = discover_cdp_neighbors(host=host, **snmp_kwargs)
        neighbors.extend(cdp)
    except Exception as e:
        logger.warning(f"[DISCOVERY] CDP failed on {host}: {e}")

    # Merge duplicates: prefer entries with IPs, prefer CDP over LLDP if same hostname
    merged = _merge_neighbors(neighbors)
    return merged


def _merge_neighbors(raw: List[Dict]) -> List[Dict]:
    """
    Deduplicate neighbors by chassis_id → hostname → ip priority.
    When both LLDP and CDP report the same device, merge fields (CDP wins on platform).
    """
    seen: Dict[str, Dict] = {}  # key -> best entry

    for n in raw:
        key = (n.get("chassis_id") or n.get("hostname") or "").lower().strip()
        if not key or key == "unknown":
            # Use IP as fallback key
            key = n.get("ip", "").strip()
        if not key:
            continue

        if key not in seen:
            seen[key] = dict(n)
        else:
            existing = seen[key]
            # Fill in missing fields
            if not existing.get("ip") and n.get("ip"):
                existing["ip"] = n["ip"]
            if not existing.get("hostname") and n.get("hostname"):
                existing["hostname"] = n["hostname"]
            if n.get("protocol") == "CDP":
                # CDP wins on platform info
                if n.get("platform") and n["platform"] != "Unknown":
                    existing["platform"] = n["platform"]
                existing["protocol"] = "LLDP+CDP"
            if not existing.get("local_port") and n.get("local_port"):
                existing["local_port"] = n["local_port"]
            if not existing.get("remote_port") and n.get("remote_port"):
                existing["remote_port"] = n["remote_port"]

    return list(seen.values())


def _enrich_with_db_status(neighbors: List[Dict], db) -> List[Dict]:
    """
    Cross-reference neighbors against the device inventory.
    Adds:
      - status: "New" | "Already Registered"
      - registered_id: device DB id if already registered
    """
    all_devices = db.query(models.Device).all()
    host_set = {d.host: d for d in all_devices}
    name_set = {d.name.lower(): d for d in all_devices}

    for n in neighbors:
        ip = n.get("ip", "")
        hostname = n.get("hostname", "")
        existing = host_set.get(ip) or name_set.get(hostname.lower())
        if existing:
            n["status"] = "Already Registered"
            n["registered_id"] = existing.id
            n["registered_name"] = existing.name
        else:
            n["status"] = "New"
            n["registered_id"] = None
            n["registered_name"] = None

    return neighbors


def discover_neighbors(
    device_id: int,
    depth: int = 1,
    task_id: str = "",
) -> Dict[str, Any]:
    """
    Main entry point for neighbor discovery.

    Args:
        device_id: Database ID of the seed device
        depth: 1 = direct neighbors only, 2 = neighbors of neighbors,
               0 = unlimited (up to MAX_DEPTH safeguard)
        task_id: Unique ID for tracking async progress

    Returns:
        Dict with keys: success, device_id, neighbors, topology_links, error
    """
    MAX_DEPTH_UNLIMITED = 5  # safeguard for unlimited mode
    effective_depth = depth if depth > 0 else MAX_DEPTH_UNLIMITED

    db = ConfigSessionLocal()
    try:
        seed_device = db.query(models.Device).filter(models.Device.id == device_id).first()
        if not seed_device:
            result = {"success": False, "error": f"Device {device_id} not found", "neighbors": []}
            _store_result(task_id, {**result, "status": "complete", "progress": 100})
            return result

        _store_result(task_id, {
            "status": "running",
            "progress": 5,
            "message": f"Starting discovery on {seed_device.name} ({seed_device.host})..."
        })

        snmp_kwargs = _get_snmp_kwargs(seed_device)
        all_neighbors: List[Dict] = []
        topology_links: List[Dict] = []
        visited_devices: Set[str] = {seed_device.host}

        # BFS queue: (host, snmp_kwargs, current_depth)
        queue = [(seed_device.host, snmp_kwargs, 1)]
        # For non-seed hosts discovered during recursion, we'll use default SNMP inherited from seed
        # (real deployments would look up credentials per-device)

        total_steps = effective_depth
        step = 0

        while queue:
            current_host, current_snmp, current_depth = queue.pop(0)
            if current_depth > effective_depth:
                continue

            step += 1
            progress = min(90, 10 + int((step / max(total_steps, 1)) * 80))
            _store_result(task_id, {
                "status": "running",
                "progress": progress,
                "message": f"Querying {current_host} (depth {current_depth}/{effective_depth})..."
            })

            logger.info(f"[DISCOVERY] Querying {current_host} at depth {current_depth}")
            try:
                raw_neighbors = _discover_single_host(current_host, current_snmp)
            except Exception as e:
                logger.error(f"[DISCOVERY] Failed on {current_host}: {e}")
                continue

            for neighbor in raw_neighbors:
                # Record topology link
                topology_links.append({
                    "source_host": current_host,
                    "target_hostname": neighbor.get("hostname", ""),
                    "target_ip": neighbor.get("ip", ""),
                    "local_interface": neighbor.get("local_port", ""),
                    "remote_interface": neighbor.get("remote_port", ""),
                    "protocol": neighbor.get("protocol", "LLDP"),
                })

                # Only add to all_neighbors if not already seen
                neigh_ip = neighbor.get("ip", "")
                neigh_host = neighbor.get("hostname", "").lower()
                already_in = any(
                    (n.get("ip") and n["ip"] == neigh_ip) or
                    (n.get("hostname", "").lower() == neigh_host and neigh_host)
                    for n in all_neighbors
                )
                if not already_in:
                    all_neighbors.append(neighbor)

                # Queue for recursive discovery
                if current_depth < effective_depth:
                    next_host = neigh_ip
                    if next_host and next_host not in visited_devices:
                        visited_devices.add(next_host)
                        # Inherit SNMP config from seed device for now
                        queue.append((next_host, snmp_kwargs, current_depth + 1))

        # Enrich with registration status
        all_neighbors = _enrich_with_db_status(all_neighbors, db)

        # Persist topology links to device_links table
        _persist_topology_links(topology_links, seed_device, all_neighbors, db)

        # Log discovery event
        db.add(models.AuditLog(
            timestamp=datetime.utcnow(),
            username="system",
            action="NETWORK_DISCOVERY",
            device_host=seed_device.host,
            details=f"Discovery (depth={depth}) found {len(all_neighbors)} neighbors.",
            level="INFO",
        ))
        db.commit()

        result = {
            "success": True,
            "device_id": device_id,
            "seed_device": seed_device.name,
            "neighbors": all_neighbors,
            "topology_links": topology_links,
            "total_found": len(all_neighbors),
            "depth_used": depth,
        }
        _store_result(task_id, {**result, "status": "complete", "progress": 100})
        return result

    except Exception as e:
        logger.exception(f"[DISCOVERY] Unexpected error: {e}")
        result = {"success": False, "error": str(e), "neighbors": []}
        _store_result(task_id, {**result, "status": "error", "progress": 100})
        return result
    finally:
        db.close()


def _persist_topology_links(
    topology_links: List[Dict],
    seed_device: models.Device,
    all_neighbors: List[Dict],
    db,
):
    """
    Persist discovered neighbor relationships to the device_links table.
    Only creates links where both endpoints are registered devices.
    """
    try:
        from db.models import DeviceLink

        # Build host -> device_id lookup
        all_devices = db.query(models.Device).all()
        host_to_id = {d.host: d.id for d in all_devices}
        name_to_id = {d.name.lower(): d.id for d in all_devices}

        now = datetime.utcnow()

        for link in topology_links:
            source_id = host_to_id.get(link["source_host"])
            if not source_id:
                continue

            target_ip = link.get("target_ip", "")
            target_name = link.get("target_hostname", "").lower()
            target_id = host_to_id.get(target_ip) or name_to_id.get(target_name)
            if not target_id:
                continue  # target not registered, skip persisting link

            # Upsert: check if link already exists
            existing = db.query(DeviceLink).filter(
                DeviceLink.source_device_id == source_id,
                DeviceLink.target_device_id == target_id,
                DeviceLink.local_interface == link.get("local_interface", ""),
            ).first()

            if existing:
                existing.last_seen = now
                existing.protocol = link.get("protocol", "LLDP")
            else:
                db.add(DeviceLink(
                    source_device_id=source_id,
                    target_device_id=target_id,
                    local_interface=link.get("local_interface", ""),
                    remote_interface=link.get("remote_interface", ""),
                    protocol=link.get("protocol", "LLDP"),
                    last_seen=now,
                ))
        db.commit()
    except Exception as e:
        logger.warning(f"[DISCOVERY] Could not persist topology links: {e}")


def import_discovered_devices(
    neighbors: List[Dict],
    seed_device_id: int,
    db,
) -> Dict[str, Any]:
    """
    Import selected discovered neighbors into the device inventory.
    Uses the seed device's credentials as a starting point.
    """
    seed = db.query(models.Device).filter(models.Device.id == seed_device_id).first()
    if not seed:
        return {"success": False, "error": "Seed device not found", "imported": 0}

    imported = 0
    skipped = 0
    errors = []

    for neighbor in neighbors:
        ip = neighbor.get("ip", "").strip()
        hostname = neighbor.get("hostname", "").strip() or ip

        if not ip:
            errors.append(f"Skipped '{hostname}': no IP address")
            skipped += 1
            continue

        # Check if already registered
        existing = db.query(models.Device).filter(models.Device.host == ip).first()
        if existing:
            skipped += 1
            continue

        # Determine device_type from classification hint
        hint = neighbor.get("device_type_hint", "Unknown")
        device_type = _hint_to_device_type(hint)

        new_device = models.Device(
            name=hostname,
            host=ip,
            device_type=device_type,
            username=seed.username,
            password_encrypted=seed.password_encrypted,
            secret_encrypted=seed.secret_encrypted,
            is_monitored=True,
            region=seed.region,
            status="UNKNOWN",
            snmp_version=seed.snmp_version,
            snmp_port=seed.snmp_port,
            snmp_timeout=seed.snmp_timeout,
            snmp_retries=seed.snmp_retries,
            snmp_community_encrypted=seed.snmp_community_encrypted,
            snmp_username=seed.snmp_username,
            snmp_auth_protocol=seed.snmp_auth_protocol,
            snmp_auth_password_encrypted=seed.snmp_auth_password_encrypted,
            snmp_priv_protocol=seed.snmp_priv_protocol,
            snmp_priv_password_encrypted=seed.snmp_priv_password_encrypted,
        )
        db.add(new_device)
        db.add(models.AuditLog(
            timestamp=datetime.utcnow(),
            username="system",
            action="AUTO_IMPORT_DEVICE",
            device_host=ip,
            details=f"Auto-imported via discovery from {seed.name}. "
                    f"Protocol: {neighbor.get('protocol','?')}. "
                    f"Type hint: {hint}.",
            level="INFO",
        ))
        imported += 1

    db.commit()
    return {
        "success": True,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }


def _hint_to_device_type(hint: str) -> str:
    """Map device_type_hint to Netmiko device_type string."""
    mapping = {
        "Router":              "cisco_ios",
        "Switch":              "cisco_ios",
        "Firewall":            "cisco_asa",
        "Wireless Controller": "cisco_wlc",
        "Access Point":        "cisco_ios",
        "Server":              "linux",
        "Unknown":             "cisco_ios",
    }
    return mapping.get(hint, "cisco_ios")


def get_topology_data(db) -> Dict[str, Any]:
    """
    Return all topology links with device details for the frontend graph.
    """
    from db.models import DeviceLink

    devices = {d.id: d for d in db.query(models.Device).all()}
    links = db.query(DeviceLink).all()

    nodes = []
    seen_ids = set()
    for d in devices.values():
        nodes.append({
            "id": str(d.id),
            "label": d.name,
            "host": d.host,
            "status": d.status,
            "device_type": d.device_type,
            "region": d.region,
            "cpu": d.last_cpu,
            "memory": d.last_memory,
            "latency": d.last_latency,
        })
        seen_ids.add(d.id)

    edges = []
    for link in links:
        if link.source_device_id in seen_ids and link.target_device_id in seen_ids:
            edges.append({
                "id": str(link.id),
                "source": str(link.source_device_id),
                "target": str(link.target_device_id),
                "local_interface": link.local_interface or "",
                "remote_interface": link.remote_interface or "",
                "protocol": link.protocol or "LLDP",
                "last_seen": link.last_seen.isoformat() if link.last_seen else None,
            })

    return {"nodes": nodes, "edges": edges}
