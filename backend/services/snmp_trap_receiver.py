"""
services/snmp_trap_receiver.py
──────────────────────────────
Enterprise SNMP Trap Receiver.

Listens on UDP 162 for incoming SNMP v2c traps, classifies them into
standardised Incident records, and writes them to the config database.

Integrated from the Streamlit prototype (update.py) into the existing
FastAPI / SQLAlchemy / Incident-management workflow.

Flow:
  Switch  ──SNMP Trap──►  snmp_trap_worker (background thread)
                           │
                           ├─ parse_trap()      → TrapEvent dataclass
                           ├─ _dedup_check()    → suppress duplicates (30 s window)
                           └─ create_incident() → Incident row + AuditLog
"""

import time
import threading
import asyncio
import logging
import random
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from pysnmp.entity import engine, config
from pysnmp.carrier.asyncio.dgram import udp
from pysnmp.entity.rfc3413 import ntfrcv

from db.database import ConfigSessionLocal
from db.models import Incident, AuditLog

logger = logging.getLogger("snmp_trap_receiver")

# ─────────────────────────────────────────────
# OID → (category, event_type, severity) mapping
# ─────────────────────────────────────────────
TRAP_TYPES: dict[str, dict] = {
    # Standard IF-MIB link traps
    "1.3.6.1.6.3.1.1.5.3": {
        "category": "Interface",
        "event_type": "LINK_DOWN",
        "severity": "major",
        "component_type": "INTERFACE",
    },
    "1.3.6.1.6.3.1.1.5.4": {
        "category": "Interface",
        "event_type": "LINK_UP",
        "severity": "warning",
        "component_type": "INTERFACE",
    },
    # Cisco envmon (fans, PSUs, temperature)
    "1.3.6.1.4.1.9.9.13": {
        "category": "Environmental",
        "event_type": "ENVIRONMENT_ALARM",
        "severity": "critical",
        "component_type": "SYSTEM",
    },
    # Cisco entity MIB (module, supervisor, chassis)
    "1.3.6.1.4.1.9.9.117": {
        "category": "Hardware",
        "event_type": "ENTITY_STATUS",
        "severity": "critical",
        "component_type": "MODULE",
    },
    # Cisco fan failure
    "1.3.6.1.4.1.9.9.13.3": {
        "category": "Environmental",
        "event_type": "FAN_FAILURE",
        "severity": "major",
        "component_type": "FAN",
    },
    # Cisco PSU failure
    "1.3.6.1.4.1.9.9.13.1": {
        "category": "Power",
        "event_type": "PSU_FAILURE",
        "severity": "critical",
        "component_type": "POWER_SUPPLY",
    },
    # Cisco temperature alarm
    "1.3.6.1.4.1.9.9.13.2": {
        "category": "Thermal",
        "event_type": "TEMPERATURE_ALARM",
        "severity": "critical",
        "component_type": "TEMPERATURE_SENSOR",
    },
    # Port-security violation
    "1.3.6.1.4.1.9.9.315.1.2.1": {
        "category": "Security",
        "event_type": "PORT_SECURITY_VIOLATION",
        "severity": "major",
        "component_type": "INTERFACE",
    },
}

# Keyword → component_type fallback (for generic envmon OIDs)
COMPONENT_PATTERNS: dict[str, str] = {
    "fan": "FAN",
    "power": "POWER_SUPPLY",
    "psu": "POWER_SUPPLY",
    "temp": "TEMPERATURE_SENSOR",
    "thermal": "TEMPERATURE_SENSOR",
    "voltage": "POWER_SYSTEM",
    "module": "MODULE",
    "supervisor": "SUPERVISOR",
    "chassis": "SYSTEM",
}

# Severity → category for auto-classification when OID not in TRAP_TYPES
CATEGORY_BY_COMPONENT: dict[str, str] = {
    "FAN": "Environmental",
    "POWER_SUPPLY": "Power",
    "TEMPERATURE_SENSOR": "Thermal",
    "POWER_SYSTEM": "Power",
    "MODULE": "Hardware",
    "SUPERVISOR": "Hardware",
    "SYSTEM": "Hardware",
    "INTERFACE": "Interface",
}

TRAP_DEDUP_WINDOW = 30  # seconds
TRAP_PORT = 162
TRAP_LISTEN_IP = "0.0.0.0"

# In-memory dedup table  {(source_ip, component, event_type): last_seen_timestamp}
_recent_traps: dict[tuple, float] = {}
_dedup_lock = threading.Lock()


@dataclass
class TrapEvent:
    source_ip: str
    component_type: str
    component_name: str
    event_type: str
    category: str
    severity: str
    interface_name: Optional[str]
    raw_payload: str
    device_name: str = "UNKNOWN"


# ─────────────────────────────────────────────────────────
# Deduplication
# ─────────────────────────────────────────────────────────

def _dedup_check(event: TrapEvent) -> bool:
    """Return True if this event should be suppressed (duplicate within window)."""
    key = (event.source_ip, event.component_type, event.event_type)
    now = time.time()
    with _dedup_lock:
        last = _recent_traps.get(key)
        if last and (now - last) < TRAP_DEDUP_WINDOW:
            return True
        _recent_traps[key] = now
    return False


# ─────────────────────────────────────────────────────────
# Trap parser
# ─────────────────────────────────────────────────────────

def _parse_trap(var_binds, source_ip: str) -> Optional[TrapEvent]:
    """Convert raw pysnmp var-binds into a TrapEvent, or None if unrecognised."""
    trap_oid = None
    payload_dump = " ".join(
        f"{name.prettyPrint()}={val.prettyPrint()}"
        for name, val in var_binds
    )

    # Extract snmpTrapOID
    for oid, value in var_binds:
        if oid.prettyPrint() == "1.3.6.1.6.3.1.1.4.1.0":
            trap_oid = value.prettyPrint()
            break

    if not trap_oid:
        return None

    # Match against known OIDs (longest prefix wins)
    event_info = None
    matched_len = 0
    for registered_oid, info in TRAP_TYPES.items():
        if trap_oid.startswith(registered_oid) and len(registered_oid) > matched_len:
            event_info = info
            matched_len = len(registered_oid)

    if not event_info:
        return None

    component_type = event_info.get("component_type", "SYSTEM")
    component_name = component_type

    # Refine component from payload keywords
    lower_payload = payload_dump.lower()
    for keyword, detected in COMPONENT_PATTERNS.items():
        if keyword in lower_payload:
            component_type = detected
            component_name = detected.replace("_", " ").title()
            break

    # Extract interface index for link traps
    interface_name = None
    if component_type == "INTERFACE":
        for oid, value in var_binds:
            oid_str = oid.prettyPrint()
            if oid_str.startswith("1.3.6.1.2.1.2.2.1.1"):
                interface_name = f"Interface_{value.prettyPrint()}"
                component_name = interface_name
                break
            # ifDescr
            if oid_str.startswith("1.3.6.1.2.1.2.2.1.2"):
                interface_name = value.prettyPrint()
                component_name = interface_name
                break

    category = event_info.get("category", CATEGORY_BY_COMPONENT.get(component_type, "Hardware"))

    return TrapEvent(
        source_ip=source_ip,
        component_type=component_type,
        component_name=component_name,
        event_type=event_info["event_type"],
        category=category,
        severity=event_info["severity"],
        interface_name=interface_name,
        raw_payload=payload_dump,
    )


# ─────────────────────────────────────────────────────────
# Incident creation
# ─────────────────────────────────────────────────────────

def _create_incident_from_trap(event: TrapEvent):
    """Write a new Incident (or escalate existing) into the config DB."""
    db = ConfigSessionLocal()
    try:
        time_now = datetime.utcnow()

        # Look up device name from DB if available
        from db.models import Device
        device = db.query(Device).filter(Device.host == event.source_ip).first()
        device_name = device.name if device else event.source_ip

        # Suppress LINK_UP / recovery events from opening new tickets
        if event.event_type == "LINK_UP":
            # Auto-resolve any open Interface incident for this device+interface
            open_inc = db.query(Incident).filter(
                Incident.device_host == event.source_ip,
                Incident.status != "resolved",
                Incident.category == "Interface",
                Incident.interface_name == event.interface_name,
            ).first()
            if open_inc:
                open_inc.status = "resolved"
                open_inc.resolvedTime = time_now
                open_inc.lastUpdated = time_now
                open_inc.details = (open_inc.details or "") + \
                    f"\nInterface back UP at {time_now}. Auto-resolved via SNMP trap."
                db.add(AuditLog(
                    timestamp=time_now, username="system",
                    action="INCIDENT_RESOLVED", device_host=event.source_ip,
                    details=f"LINK_UP trap: {open_inc.id} auto-resolved.",
                    level="INFO"
                ))
                db.commit()
            return

        # Check for existing open incident (dedup across restart)
        existing = db.query(Incident).filter(
            Incident.device_host == event.source_ip,
            Incident.status != "resolved",
            Incident.category == event.category,
            Incident.component_type == event.component_type,
        ).first()

        if existing:
            # Escalate if severity is worse
            sev_rank = {"warning": 1, "low": 1, "minor": 2, "medium": 2, "major": 3, "high": 3, "critical": 4}
            if sev_rank.get(event.severity, 0) > sev_rank.get(existing.severity, 0):
                existing.severity = event.severity
                existing.lastUpdated = time_now
                existing.details = (existing.details or "") + \
                    f"\nEscalated to {event.severity.upper()} at {time_now}."
                db.commit()
            return

        ticket_id = f"TK-{time_now.year}-{random.randint(10000, 99999)}"

        detail_lines = [
            f"Category: {event.category}",
            f"Event: {event.event_type}",
            f"Component: {event.component_name}",
            f"Source IP: {event.source_ip}",
        ]
        if event.interface_name:
            detail_lines.append(f"Interface: {event.interface_name}")
        detail_lines.append(f"Raw: {event.raw_payload[:300]}")

        new_incident = Incident(
            id=ticket_id,
            device_host=event.source_ip,
            deviceName=device_name,
            detectedTime=time_now,
            severity=event.severity,
            status="open",
            lastUpdated=time_now,
            details="\n".join(detail_lines),
            category=event.category,
            event_source="SNMP_TRAP",
            component_type=event.component_type,
            component_name=event.component_name,
            hardware_sensor=event.event_type,
            interface_name=event.interface_name,
        )
        db.add(new_incident)
        db.add(AuditLog(
            timestamp=time_now, username="system",
            action="INCIDENT_OPENED", device_host=event.source_ip,
            details=f"SNMP Trap: {ticket_id} opened. {event.category}/{event.event_type}.",
            level="WARNING" if event.severity in ("major", "medium") else "ERROR"
        ))
        db.commit()
        logger.info(f"[TRAP] New incident {ticket_id}: {device_name} | {event.category} | {event.event_type}")

    except Exception as e:
        logger.error(f"[TRAP] DB write failed: {e}", exc_info=True)
    finally:
        db.close()


# ─────────────────────────────────────────────────────────
# Background worker (thread entry point)
# ─────────────────────────────────────────────────────────

def snmp_trap_worker(community_string: str = "public"):
    """
    Blocking function: starts the asyncio event loop and the pysnmp
    trap receiver.  Must be called inside a daemon thread.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    snmp_engine_obj = engine.SnmpEngine()

    def trap_callback(
        snmpEngine, stateReference, contextEngineId,
        contextName, varBinds, cbCtx
    ):
        try:
            # pysnmp 5.x exposes transport info via execContext
            source_ip = "UNKNOWN"
            try:
                exec_ctx = snmpEngine.observer.getExecutionContext(
                    "rfc3412.receiveMessage:request"
                )
                source_ip = str(exec_ctx.get("transportAddress", ("UNKNOWN",))[0])
            except Exception:
                pass

            event = _parse_trap(varBinds, source_ip)
            if event and not _dedup_check(event):
                _create_incident_from_trap(event)

        except Exception as e:
            logger.error(f"[TRAP] Callback error: {e}", exc_info=True)

    try:
        config.addTransport(
            snmp_engine_obj,
            udp.domainName + (1,),
            udp.UdpTransport().openServerMode((TRAP_LISTEN_IP, TRAP_PORT))
        )
        config.addV1System(snmp_engine_obj, "trap-receiver", community_string)
        ntfrcv.NotificationReceiver(snmp_engine_obj, trap_callback)
        logger.info(f"[TRAP] SNMP trap receiver listening on {TRAP_LISTEN_IP}:{TRAP_PORT}")
        loop.run_forever()

    except PermissionError:
        logger.error(
            "[TRAP] Cannot bind port 162 – run as root or use authbind. "
            "Trap receiver NOT started."
        )
    except Exception as e:
        logger.error(f"[TRAP] Receiver startup error: {e}", exc_info=True)
    finally:
        loop.close()


def start_trap_receiver(community_string: str = "public"):
    """Launch the SNMP trap receiver in a daemon thread."""
    t = threading.Thread(
        target=snmp_trap_worker,
        args=(community_string,),
        daemon=True,
        name="snmp-trap-receiver"
    )
    t.start()
    logger.info("[TRAP] Trap receiver thread started.")
