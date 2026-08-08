"""
services/worker.py
──────────────────
Background polling workers – extended to support:
  • Interface state monitoring  → Interface Down/Up/Err-Disabled incidents
  • Environmental monitoring    → Fan, PSU, Temperature incidents

All new incident types flow through the existing Incident model and
AuditLog workflow.  No parallel ticketing systems are introduced.
"""

import time
import threading
import random
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from sqlalchemy.orm import Session

from config import PING_INTERVAL, METRICS_INTERVAL
from db.database import ConfigSessionLocal, MetricsSessionLocal
from db.models import Device, Metric, Setting, Incident, AuditLog
from db.security import decrypt_value
from collectors.cisco import CiscoIOSCollector

executor = ThreadPoolExecutor(max_workers=20)
stop_event = threading.Event()


# ─────────────────────────────────────────────────────
# Settings helper
# ─────────────────────────────────────────────────────

def get_db_settings():
    db = ConfigSessionLocal()
    try:
        ping_row    = db.query(Setting).filter(Setting.key == "ping_interval").first()
        metrics_row = db.query(Setting).filter(Setting.key == "metrics_interval").first()
        return (
            int(ping_row.value)    if ping_row    else PING_INTERVAL,
            int(metrics_row.value) if metrics_row else METRICS_INTERVAL,
        )
    except Exception as e:
        print(f"[WORKER SETTINGS ERROR] {e}")
        return PING_INTERVAL, METRICS_INTERVAL
    finally:
        db.close()


# ─────────────────────────────────────────────────────
# Severity helpers
# ─────────────────────────────────────────────────────

SEVERITY_RANK = {
    "warning": 1, "low": 1, "minor": 2, "medium": 2,
    "major": 3, "high": 3, "critical": 4,
}


def _open_incident(
    db: Session,
    device: Device,
    time_now: datetime,
    *,
    severity: str,
    category: str,
    event_source: str,
    component_type: str = None,
    component_name: str = None,
    interface_name: str = None,
    interface_description: str = None,
    interface_mode: str = None,
    interface_admin_state: str = None,
    interface_oper_state: str = None,
    native_vlan: str = None,
    allowed_vlans: str = None,
    port_channel: str = None,
    hardware_sensor: str = None,
    threshold_value: float = None,
    actual_value: float = None,
    details: str = "",
):
    """
    Open a new incident or escalate an existing one.
    Duplicate suppression: one open incident per (device, category, component_type).
    """
    existing = db.query(Incident).filter(
        Incident.device_host == device.host,
        Incident.status != "resolved",
        Incident.category == category,
        Incident.component_type == (component_type or "SYSTEM"),
        Incident.interface_name == interface_name,
    ).first()

    if existing:
        if SEVERITY_RANK.get(severity, 0) > SEVERITY_RANK.get(existing.severity, 0):
            existing.severity = severity
            existing.lastUpdated = time_now
            existing.details = (existing.details or "") + f"\nEscalated to {severity.upper()} at {time_now}."
            db.add(AuditLog(
                timestamp=time_now, username="system",
                action="INCIDENT_ESCALATED", device_host=device.host,
                details=f"Ticket {existing.id} escalated to {severity.upper()}.",
                level="ERROR",
            ))
            db.commit()
        return

    ticket_id = f"TK-{time_now.year}-{random.randint(10000, 99999)}"
    print(f"[WORKER] Incident {ticket_id}: {device.name} | {category} | {component_name or interface_name}")

    inc = Incident(
        id=ticket_id,
        device_host=device.host,
        deviceName=device.name,
        detectedTime=time_now,
        severity=severity,
        status="open",
        lastUpdated=time_now,
        details=details,
        category=category,
        event_source=event_source,
        component_type=component_type,
        component_name=component_name,
        hardware_sensor=hardware_sensor,
        threshold_value=threshold_value,
        actual_value=actual_value,
        interface_name=interface_name,
        interface_description=interface_description,
        interface_mode=interface_mode,
        interface_admin_state=interface_admin_state,
        interface_oper_state=interface_oper_state,
        native_vlan=native_vlan,
        allowed_vlans=allowed_vlans,
        port_channel=port_channel,
    )
    db.add(inc)
    db.add(AuditLog(
        timestamp=time_now, username="system",
        action="INCIDENT_OPENED", device_host=device.host,
        details=f"Ticket {ticket_id} opened. {category}/{component_name or interface_name}.",
        level="WARNING" if severity in ("major", "medium", "minor") else "ERROR",
    ))
    db.commit()


def _resolve_incident(db: Session, device: Device, time_now: datetime, *, category: str,
                      component_type: str = None, interface_name: str = None, note: str = ""):
    inc = db.query(Incident).filter(
        Incident.device_host == device.host,
        Incident.status != "resolved",
        Incident.category == category,
        Incident.component_type == (component_type or "SYSTEM"),
        Incident.interface_name == interface_name,
    ).first()
    if inc:
        inc.status = "resolved"
        inc.resolvedTime = time_now
        inc.lastUpdated = time_now
        inc.details = (inc.details or "") + f"\nAuto-resolved at {time_now}. {note}"
        db.add(AuditLog(
            timestamp=time_now, username="system",
            action="INCIDENT_RESOLVED", device_host=device.host,
            details=f"Ticket {inc.id} auto-resolved. {note}",
            level="INFO",
        ))
        db.commit()


# ─────────────────────────────────────────────────────
# Connectivity worker (ping)  – extended
# ─────────────────────────────────────────────────────

def ping_device_worker(device_id: int):
    config_db = ConfigSessionLocal()
    metrics_db = MetricsSessionLocal()
    try:
        device = config_db.query(Device).filter(Device.id == device_id).first()
        if not device or not device.is_monitored:
            return

        password = decrypt_value(device.password_encrypted)
        secret   = decrypt_value(device.secret_encrypted)

        collector = CiscoIOSCollector(device.host, device.username, password, secret)
        ping_res = collector.ping()

        time_now = datetime.utcnow()
        device.status       = ping_res["state"]
        device.last_latency = ping_res["latency"]
        device.last_packet_loss = ping_res["packet_loss"]
        if ping_res["reachable"]:
            device.last_seen = time_now
        config_db.commit()

        metrics_db.add(Metric(
            device_host=device.host,
            timestamp=time_now,
            latency=ping_res["latency"],
            packet_loss=ping_res["packet_loss"],
            cpu_utilization=device.last_cpu,
            memory_utilization=device.last_memory,
            is_mocked=False,
        ))
        metrics_db.commit()

        is_down     = not ping_res["reachable"] or ping_res["state"] == "DOWN"
        is_degraded = ping_res["state"] == "DEGRADED"

        if is_down or is_degraded:
            severity = "critical" if is_down else "medium"
            _open_incident(
                config_db, device, time_now,
                severity=severity,
                category="Connectivity",
                event_source="PING",
                component_type="SYSTEM",
                component_name="Network Connectivity",
                details=(
                    f"Alert: {device.name} status changed to {device.status} "
                    f"(Latency: {ping_res['latency']}ms, Packet Loss: {ping_res['packet_loss']}%)."
                ),
            )
        elif ping_res["reachable"] and ping_res["state"] == "UP":
            _resolve_incident(
                config_db, device, time_now,
                category="Connectivity",
                component_type="SYSTEM",
                note="Device back ONLINE.",
            )

    except Exception as e:
        print(f"[WORKER ERROR] Ping failed for device ID {device_id}: {e}")
    finally:
        config_db.close()
        metrics_db.close()


# ─────────────────────────────────────────────────────
# Metrics worker (CPU / memory)
# ─────────────────────────────────────────────────────

def metrics_device_worker(device_id: int):
    config_db = ConfigSessionLocal()
    metrics_db = MetricsSessionLocal()
    try:
        device = config_db.query(Device).filter(Device.id == device_id).first()
        if not device or not device.is_monitored:
            return

        password = decrypt_value(device.password_encrypted)
        secret   = decrypt_value(device.secret_encrypted)

        collector   = CiscoIOSCollector(device.host, device.username, password, secret)
        metrics_res = collector.get_metrics()

        time_now = datetime.utcnow()
        device.last_cpu    = metrics_res["cpu_utilization"]
        device.last_memory = metrics_res["memory_utilization"]
        config_db.commit()

        metrics_db.add(Metric(
            device_host=device.host,
            timestamp=time_now,
            latency=device.last_latency,
            packet_loss=device.last_packet_loss,
            cpu_utilization=metrics_res["cpu_utilization"],
            memory_utilization=metrics_res["memory_utilization"],
            is_mocked=False,
        ))
        metrics_db.commit()
        print(f"[WORKER] Metrics {device.host}: CPU={metrics_res['cpu_utilization']}%, Mem={metrics_res['memory_utilization']}%")

    except Exception as e:
        print(f"[WORKER ERROR] Metrics poll failed for device ID {device_id}: {e}")
    finally:
        config_db.close()
        metrics_db.close()


# ─────────────────────────────────────────────────────
# Interface worker  (NEW)
# ─────────────────────────────────────────────────────

def interface_device_worker(device_id: int):
    """
    Polls interface status via SSH and generates incidents for:
      - Interface Down (severity depends on mode)
      - Err-Disabled interfaces
      Auto-resolves when interfaces come back up.
    """
    config_db = ConfigSessionLocal()
    try:
        device = config_db.query(Device).filter(Device.id == device_id).first()
        if not device or not device.is_monitored or device.status == "DOWN":
            return

        password = decrypt_value(device.password_encrypted)
        secret   = decrypt_value(device.secret_encrypted)

        collector  = CiscoIOSCollector(device.host, device.username, password, secret)
        interfaces = collector.get_interfaces()
        time_now   = datetime.utcnow()

        for iface in interfaces:
            oper  = iface.get("oper_state", "")
            admin = iface.get("admin_state", "")
            mode  = iface.get("mode", "Access")
            name  = iface["name"]

            is_down        = oper.lower() in ("down", "notconnect", "notconnected")
            is_err_disabled = "err" in oper.lower()
            is_admin_down  = admin.lower() == "down"

            # Skip intentionally disabled interfaces
            if is_admin_down and not is_err_disabled:
                _resolve_incident(config_db, device, time_now,
                                  category="Interface", component_type="INTERFACE",
                                  interface_name=name, note="Admin shutdown.")
                continue

            if is_err_disabled:
                _open_incident(
                    config_db, device, time_now,
                    severity="major",
                    category="Security",
                    event_source="SSH_POLL",
                    component_type="INTERFACE",
                    component_name=name,
                    interface_name=name,
                    interface_description=iface.get("description", ""),
                    interface_mode=mode,
                    interface_admin_state=admin,
                    interface_oper_state="Err-Disabled",
                    native_vlan=iface.get("native_vlan", ""),
                    allowed_vlans=iface.get("allowed_vlans", ""),
                    port_channel=iface.get("port_channel", ""),
                    details=(
                        f"Port Security Violation / Err-Disabled\n"
                        f"Device: {device.name}\nIP: {device.host}\n"
                        f"Interface: {name}\nMode: {mode}"
                    ),
                )
                continue

            if is_down:
                # Trunk/uplink → Major; Access → Minor
                severity = "major" if mode in ("Trunk", "Routed") else "minor"
                _open_incident(
                    config_db, device, time_now,
                    severity=severity,
                    category="Interface",
                    event_source="SSH_POLL",
                    component_type="INTERFACE",
                    component_name=name,
                    interface_name=name,
                    interface_description=iface.get("description", ""),
                    interface_mode=mode,
                    interface_admin_state=admin,
                    interface_oper_state="Down",
                    native_vlan=iface.get("native_vlan", ""),
                    allowed_vlans=iface.get("allowed_vlans", ""),
                    port_channel=iface.get("port_channel", ""),
                    details=(
                        f"Interface Down\nDevice: {device.name}\nIP: {device.host}\n"
                        f"Interface: {name}\nDescription: {iface.get('description','')}\n"
                        f"Mode: {mode}\nAllowed VLANs: {iface.get('allowed_vlans','')}\n"
                        f"Admin State: {admin}\nOper State: Down"
                    ),
                )
            else:
                # Interface is up – auto-resolve any open incident
                _resolve_incident(config_db, device, time_now,
                                  category="Interface", component_type="INTERFACE",
                                  interface_name=name, note="Interface back UP.")

    except Exception as e:
        print(f"[WORKER ERROR] Interface poll failed for device ID {device_id}: {e}")
    finally:
        config_db.close()


# ─────────────────────────────────────────────────────
# Environmental worker  (NEW)
# ─────────────────────────────────────────────────────

def environment_device_worker(device_id: int):
    """
    Polls environmental sensors via SSH and generates incidents for:
      - Fan failures
      - PSU failures
      - Temperature warnings and critical alerts
    """
    config_db = ConfigSessionLocal()
    try:
        device = config_db.query(Device).filter(Device.id == device_id).first()
        if not device or not device.is_monitored or device.status == "DOWN":
            return

        password = decrypt_value(device.password_encrypted)
        secret   = decrypt_value(device.secret_encrypted)

        collector = CiscoIOSCollector(device.host, device.username, password, secret)
        env       = collector.get_environment()
        time_now  = datetime.utcnow()

        # ── Fans ──────────────────────────────────────
        for fan in env.get("fans", []):
            if fan["status"] != "OK":
                _open_incident(
                    config_db, device, time_now,
                    severity="major",
                    category="Environmental",
                    event_source="SSH_POLL",
                    component_type="FAN",
                    component_name=fan["name"][:40],
                    hardware_sensor="FAN_STATUS",
                    details=(
                        f"Fan Failure\nDevice: {device.name}\nIP: {device.host}\n"
                        f"Component: {fan['name']}\nStatus: {fan['status']}"
                    ),
                )
            else:
                _resolve_incident(config_db, device, time_now,
                                  category="Environmental", component_type="FAN",
                                  note=f"Fan {fan['name']} status OK.")

        # ── PSUs ──────────────────────────────────────
        for psu in env.get("psus", []):
            if psu["status"] != "OK":
                _open_incident(
                    config_db, device, time_now,
                    severity="critical",
                    category="Power",
                    event_source="SSH_POLL",
                    component_type="POWER_SUPPLY",
                    component_name=psu["name"][:40],
                    hardware_sensor="PSU_STATUS",
                    details=(
                        f"PSU Failure\nDevice: {device.name}\nIP: {device.host}\n"
                        f"Component: {psu['name']}\nStatus: {psu['status']}"
                    ),
                )
            else:
                _resolve_incident(config_db, device, time_now,
                                  category="Power", component_type="POWER_SUPPLY",
                                  note=f"PSU {psu['name']} status OK.")

        # ── Temperature ───────────────────────────────
        for temp in env.get("temps", []):
            if temp["status"] == "CRITICAL":
                _open_incident(
                    config_db, device, time_now,
                    severity="critical",
                    category="Thermal",
                    event_source="SSH_POLL",
                    component_type="TEMPERATURE_SENSOR",
                    component_name=temp["name"][:40],
                    hardware_sensor="TEMPERATURE",
                    threshold_value=float(temp.get("threshold", 75)),
                    actual_value=float(temp.get("value", 0)),
                    details=(
                        f"Temperature Critical\nDevice: {device.name}\nIP: {device.host}\n"
                        f"Sensor: {temp['name']}\nValue: {temp['value']}°C "
                        f"/ Threshold: {temp['threshold']}°C"
                    ),
                )
            elif temp["status"] == "WARNING":
                _open_incident(
                    config_db, device, time_now,
                    severity="minor",
                    category="Thermal",
                    event_source="SSH_POLL",
                    component_type="TEMPERATURE_SENSOR",
                    component_name=temp["name"][:40],
                    hardware_sensor="TEMPERATURE",
                    threshold_value=float(temp.get("threshold", 75)),
                    actual_value=float(temp.get("value", 0)),
                    details=(
                        f"Temperature Warning\nDevice: {device.name}\nIP: {device.host}\n"
                        f"Sensor: {temp['name']}\nValue: {temp['value']}°C "
                        f"/ Threshold: {temp['threshold']}°C"
                    ),
                )
            else:
                _resolve_incident(config_db, device, time_now,
                                  category="Thermal", component_type="TEMPERATURE_SENSOR",
                                  note=f"Temp sensor {temp['name']} within range.")

    except Exception as e:
        print(f"[WORKER ERROR] Environment poll failed for device ID {device_id}: {e}")
    finally:
        config_db.close()


# ─────────────────────────────────────────────────────
# Poll loops
# ─────────────────────────────────────────────────────

def ping_loop():
    print("[WORKER] Starting ping monitoring loop...")
    last_ping_time = 0
    while not stop_event.is_set():
        current_time = time.time()
        ping_interval, _ = get_db_settings()
        if current_time - last_ping_time >= ping_interval:
            last_ping_time = current_time
            db = ConfigSessionLocal()
            try:
                ids = [d.id for d in db.query(Device).filter(Device.is_monitored == True).all()]
                for d_id in ids:
                    executor.submit(ping_device_worker, d_id)
            except Exception as e:
                print(f"[WORKER LOOP ERROR] {e}")
            finally:
                db.close()
        time.sleep(1)


def metrics_loop():
    print("[WORKER] Starting metrics polling loop...")
    _, metrics_interval = get_db_settings()
    last_metrics_time = time.time() - metrics_interval + 5
    while not stop_event.is_set():
        current_time = time.time()
        _, metrics_interval = get_db_settings()
        if current_time - last_metrics_time >= metrics_interval:
            last_metrics_time = current_time
            db = ConfigSessionLocal()
            try:
                ids = [d.id for d in db.query(Device).filter(Device.is_monitored == True).all()]
                for d_id in ids:
                    executor.submit(metrics_device_worker, d_id)
            except Exception as e:
                print(f"[WORKER LOOP ERROR] {e}")
            finally:
                db.close()
        time.sleep(1)


def interface_loop():
    """Poll interface status every metrics_interval seconds."""
    print("[WORKER] Starting interface monitoring loop...")
    _, metrics_interval = get_db_settings()
    last_poll = time.time() - metrics_interval + 15  # stagger from metrics loop
    while not stop_event.is_set():
        current_time = time.time()
        _, metrics_interval = get_db_settings()
        if current_time - last_poll >= metrics_interval:
            last_poll = current_time
            db = ConfigSessionLocal()
            try:
                ids = [d.id for d in db.query(Device).filter(Device.is_monitored == True).all()]
                for d_id in ids:
                    executor.submit(interface_device_worker, d_id)
            except Exception as e:
                print(f"[WORKER LOOP ERROR] {e}")
            finally:
                db.close()
        time.sleep(1)


def environment_loop():
    """Poll environmental health every metrics_interval seconds."""
    print("[WORKER] Starting environmental monitoring loop...")
    _, metrics_interval = get_db_settings()
    last_poll = time.time() - metrics_interval + 30  # further stagger
    while not stop_event.is_set():
        current_time = time.time()
        _, metrics_interval = get_db_settings()
        if current_time - last_poll >= metrics_interval:
            last_poll = current_time
            db = ConfigSessionLocal()
            try:
                ids = [d.id for d in db.query(Device).filter(Device.is_monitored == True).all()]
                for d_id in ids:
                    executor.submit(environment_device_worker, d_id)
            except Exception as e:
                print(f"[WORKER LOOP ERROR] {e}")
            finally:
                db.close()
        time.sleep(1)


# ─────────────────────────────────────────────────────
# Lifecycle
# ─────────────────────────────────────────────────────

def start_background_workers():
    global stop_event
    stop_event.clear()
    threading.Thread(target=ping_loop,        daemon=True, name="ping-loop").start()
    threading.Thread(target=metrics_loop,     daemon=True, name="metrics-loop").start()
    threading.Thread(target=interface_loop,   daemon=True, name="interface-loop").start()
    threading.Thread(target=environment_loop, daemon=True, name="environment-loop").start()
    print("[WORKER] All background workers started (ping, metrics, interface, environment).")


def stop_background_workers():
    stop_event.set()
    executor.shutdown(wait=True)
    print("[WORKER] Background workers stopped.")
