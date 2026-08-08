import io
import os
import secrets as _secrets
import zipfile
import hashlib
import random
from datetime import datetime, timedelta
from typing import List, Optional, Dict
from fastapi import FastAPI, Depends, HTTPException, BackgroundTasks, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from fastapi import WebSocket
from collectors.packet_sniffer import PacketSniffer

import config
from db.database import config_engine, get_config_db, get_metrics_db
from db import models
from db.security import encrypt_value, decrypt_value
from services.worker import start_background_workers, stop_background_workers
from services.snmp_trap_receiver import start_trap_receiver
from services.backup import execute_device_backup
from services.queue import BackupQueueManager
from routers.ssh import router as ssh_router
from routers.discovery import router as discovery_router

app = FastAPI(title="Enterprise Network Dashboard")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(ssh_router)
app.include_router(discovery_router)


# ---------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------
@app.on_event("startup")
def startup_event():
    print("[SERVER] Initialising database tables...")
    models.Base.metadata.create_all(bind=config_engine)

    # Schema migration – add columns if missing
    from sqlalchemy import text
    with config_engine.connect() as conn:
        for col_name, col_type in [
            ("device_name", "VARCHAR"),
            ("device_type", "VARCHAR"),
            ("start_time", "TIMESTAMP"),
            ("end_time", "TIMESTAMP"),
            ("triggered_by", "VARCHAR"),
        ]:
            try:
                conn.execute(text(f"ALTER TABLE backups ADD COLUMN {col_name} {col_type}"))
                print(f"[DB MIGRATION] Added column '{col_name}' to backups table.")
            except Exception:
                pass  # Column already exists

        for col_name, col_def in [
            ("ssh_username", "VARCHAR"),
            ("ssh_password_encrypted", "VARCHAR"),
            ("ssh_port", "INTEGER DEFAULT 22"),
            ("ssh_enabled", "BOOLEAN DEFAULT 0"),
            ("ssh_status", "VARCHAR DEFAULT 'UNKNOWN'"),
            ("ssh_last_connected", "TIMESTAMP"),
            ("ssh_last_failed", "TIMESTAMP"),
            ("snmp_version", "VARCHAR DEFAULT 'v2c'"),
            ("snmp_port", "INTEGER DEFAULT 161"),
            ("snmp_timeout", "INTEGER DEFAULT 5"),
            ("snmp_retries", "INTEGER DEFAULT 1"),
            ("snmp_community_encrypted", "VARCHAR"),
            ("snmp_username", "VARCHAR"),
            ("snmp_auth_protocol", "VARCHAR"),
            ("snmp_auth_password_encrypted", "VARCHAR"),
            ("snmp_priv_protocol", "VARCHAR"),
            ("snmp_priv_password_encrypted", "VARCHAR"),
        ]:
            try:
                conn.execute(text(f"ALTER TABLE devices ADD COLUMN {col_name} {col_def}"))
                print(f"[DB MIGRATION] Added column '{col_name}' to devices table.")
            except Exception:
                pass  # Column already exists

    db = next(get_config_db())
    try:
        if db.query(models.Setting).count() == 0:
            print("[SERVER] Empty database – bootstrapping default settings and admin user only...")
            bootstrap_database(db)
    finally:
        db.close()

    # Schema migration – extend incidents table for switch/env monitoring
    with config_engine.connect() as conn:
        for col_name, col_def in [
            ("category",               "VARCHAR DEFAULT 'Connectivity'"),
            ("event_source",            "VARCHAR DEFAULT 'PING'"),
            ("component_type",          "VARCHAR"),
            ("component_name",          "VARCHAR"),
            ("hardware_sensor",         "VARCHAR"),
            ("threshold_value",         "FLOAT"),
            ("actual_value",            "FLOAT"),
            ("interface_name",          "VARCHAR"),
            ("interface_description",   "VARCHAR"),
            ("interface_mode",          "VARCHAR"),
            ("interface_admin_state",   "VARCHAR"),
            ("interface_oper_state",    "VARCHAR"),
            ("native_vlan",             "VARCHAR"),
            ("allowed_vlans",           "VARCHAR"),
            ("port_channel",            "VARCHAR"),
        ]:
            try:
                conn.execute(text(f"ALTER TABLE incidents ADD COLUMN {col_name} {col_def}"))
                print(f"[DB MIGRATION] Added column '{col_name}' to incidents table.")
            except Exception:
                pass  # Column already exists

    # Schema migration – device classification and discovery tables
    with config_engine.connect() as conn:
        for col_name, col_def in [
            ("device_classification", "VARCHAR"),
        ]:
            try:
                conn.execute(text(f"ALTER TABLE devices ADD COLUMN {col_name} {col_def}"))
                print(f"[DB MIGRATION] Added column '{col_name}' to devices table.")
            except Exception:
                pass

        # Create device_links table if it doesn't exist
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS device_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_device_id INTEGER NOT NULL,
                    target_device_id INTEGER NOT NULL,
                    local_interface VARCHAR,
                    remote_interface VARCHAR,
                    protocol VARCHAR DEFAULT 'LLDP',
                    last_seen TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """))
            conn.commit()
            print("[DB MIGRATION] Ensured device_links table exists.")
        except Exception as e:
            print(f"[DB MIGRATION] device_links table: {e}")

    start_background_workers()
    print("[SERVER] Background workers launched.")

    # Start SNMP trap receiver
    db_for_snmp = next(get_config_db())
    try:
        snmp_comm_row = db_for_snmp.query(models.Setting).filter(
            models.Setting.key == "snmp_community"
        ).first()
        community = snmp_comm_row.value if snmp_comm_row else "public"
    except Exception:
        community = "public"
    finally:
        db_for_snmp.close()
    start_trap_receiver(community_string=community)
    print("[SERVER] SNMP trap receiver started.")


@app.on_event("shutdown")
def shutdown_event():
    stop_background_workers()
    print("[SERVER] Shutdown complete.")


def bootstrap_database(db: Session):
    """Seeds default settings, admin user, and the 36 Cisco devices."""
    # 1. Default settings (simulation_mode permanently disabled)
    default_settings = [
        {"key": "ping_interval",    "value": "15",  "description": "Ping frequency in seconds"},
        {"key": "metrics_interval", "value": "300", "description": "SSH metrics polling interval in seconds"},
        {"key": "backup_interval",  "value": "300", "description": "Automatic backup interval in seconds"},
        {"key": "simulation_mode",  "value": "false", "description": "Simulation mode – always disabled in production"},
    ]
    for ds in default_settings:
        db.add(models.Setting(key=ds["key"], value=ds["value"], description=ds["description"]))

    # 2. Default admin user
    hashed_pass = hashlib.sha256(("admin" + config.SECRET_KEY).encode()).hexdigest()
    db.add(models.User(username="admin", password_hash=hashed_pass, role="admin"))

    db.commit()
    print("[SERVER] Bootstrapped default settings and admin user (no devices seeded).")


# ---------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------
class DeviceCreate(BaseModel):
    name: str
    host: str
    device_type: str = "cisco_ios"
    username: str
    password: str
    secret: Optional[str] = None
    is_monitored: bool = True
    region: str = "Default"

    # SNMP configuration
    snmp_version: str = "v2c"          # "v2c" or "v3"
    snmp_port: int = 161
    snmp_timeout: int = 5
    snmp_retries: int = 1
    # SNMP v2c
    snmp_community: Optional[str] = None
    # SNMP v3
    snmp_username: Optional[str] = None
    snmp_auth_protocol: Optional[str] = None   # MD5, SHA, SHA-256
    snmp_auth_password: Optional[str] = None
    snmp_priv_protocol: Optional[str] = None   # DES, AES
    snmp_priv_password: Optional[str] = None

class DeviceUpdate(BaseModel):
    name: Optional[str] = None
    host: Optional[str] = None
    device_type: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    secret: Optional[str] = None
    is_monitored: Optional[bool] = None
    region: Optional[str] = None

    # SSH configuration
    ssh_enabled: Optional[bool] = None

    # SNMP configuration
    snmp_version: Optional[str] = None
    snmp_port: Optional[int] = None
    snmp_timeout: Optional[int] = None
    snmp_retries: Optional[int] = None
    snmp_community: Optional[str] = None
    snmp_username: Optional[str] = None
    snmp_auth_protocol: Optional[str] = None
    snmp_auth_password: Optional[str] = None
    snmp_priv_protocol: Optional[str] = None
    snmp_priv_password: Optional[str] = None






VALID_SNMP_AUTH_PROTOCOLS = {"MD5", "SHA", "SHA-256"}
VALID_SNMP_PRIV_PROTOCOLS = {"DES", "AES"}


def validate_snmp_fields(data: "DeviceCreate"):
    """Mandatory-field validation based on the selected SNMP version (req 2.3)."""
    version = (data.snmp_version or "v2c").lower()
    if version not in ("v2c", "v3"):
        raise HTTPException(status_code=400, detail="snmp_version must be 'v2c' or 'v3'.")

    if version == "v2c":
        if not data.snmp_community:
            raise HTTPException(status_code=400, detail="Community String is required for SNMP v2c.")
    else:  # v3
        missing = []
        if not data.snmp_username:
            missing.append("Username")
        if not data.snmp_auth_protocol:
            missing.append("Authentication Protocol")
        elif data.snmp_auth_protocol.upper() not in VALID_SNMP_AUTH_PROTOCOLS:
            raise HTTPException(status_code=400, detail="Authentication Protocol must be MD5, SHA, or SHA-256.")
        if not data.snmp_auth_password:
            missing.append("Authentication Password")
        if not data.snmp_priv_protocol:
            missing.append("Privacy Protocol")
        elif data.snmp_priv_protocol.upper() not in VALID_SNMP_PRIV_PROTOCOLS:
            raise HTTPException(status_code=400, detail="Privacy Protocol must be DES or AES.")
        if not data.snmp_priv_password:
            missing.append("Privacy Password")
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required SNMP v3 fields: {', '.join(missing)}."
            )

    if not (1 <= data.snmp_port <= 65535):
        raise HTTPException(status_code=400, detail="SNMP port must be between 1 and 65535.")
    if data.snmp_timeout <= 0:
        raise HTTPException(status_code=400, detail="SNMP timeout must be greater than 0.")
    if data.snmp_retries < 0:
        raise HTTPException(status_code=400, detail="SNMP retry count cannot be negative.")


class UserLogin(BaseModel):
    username: str
    password: str

class UserRegister(BaseModel):
    username: str
    password: str
    role: str = "admin"

class SettingsUpdate(BaseModel):
    ping_interval: int
    metrics_interval: int
    backup_interval: int


# ---------------------------------------------------------------
# Auth Endpoints
# ---------------------------------------------------------------
@app.post("/api/auth/login")
def login(user_in: UserLogin, db: Session = Depends(get_config_db)):
    user = db.query(models.User).filter(models.User.username == user_in.username).first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid credentials.")
    hashed = hashlib.sha256((user_in.password + config.SECRET_KEY).encode()).hexdigest()
    if user.password_hash != hashed:
        raise HTTPException(status_code=400, detail="Invalid credentials.")
    return {
        "status": "success",
        "username": user.username,
        "role": user.role,
        "token": f"token-{user.username}-{random.randint(1000,9999)}"
    }

@app.post("/api/auth/register")
def register_user(user_in: UserRegister, db: Session = Depends(get_config_db)):
    if db.query(models.User).filter(models.User.username == user_in.username).first():
        raise HTTPException(status_code=400, detail="Username already registered.")
    hashed = hashlib.sha256((user_in.password + config.SECRET_KEY).encode()).hexdigest()
    db.add(models.User(username=user_in.username, password_hash=hashed, role=user_in.role))
    db.commit()
    return {"message": "User registered successfully", "username": user_in.username}


# ---------------------------------------------------------------
# Settings Endpoints
# ---------------------------------------------------------------
@app.get("/api/config-env")
def get_config_env(db: Session = Depends(get_config_db)):
    ping_row    = db.query(models.Setting).filter(models.Setting.key == "ping_interval").first()
    metrics_row = db.query(models.Setting).filter(models.Setting.key == "metrics_interval").first()
    return {
        "environment":      config.ENVIRONMENT,
        "ping_interval":    int(ping_row.value) if ping_row else config.PING_INTERVAL,
        "metrics_interval": int(metrics_row.value) if metrics_row else config.METRICS_INTERVAL,
        "backup_path":      os.path.abspath(config.BACKUP_PATH),
    }

@app.get("/api/settings")
def get_settings(db: Session = Depends(get_config_db)):
    return {s.key: s.value for s in db.query(models.Setting).all()}

@app.put("/api/settings")
def update_settings(settings_in: SettingsUpdate, db: Session = Depends(get_config_db)):
    keys = {
        "ping_interval":    str(settings_in.ping_interval),
        "metrics_interval": str(settings_in.metrics_interval),
        "backup_interval":  str(settings_in.backup_interval),
    }
    for key, val in keys.items():
        row = db.query(models.Setting).filter(models.Setting.key == key).first()
        if row:
            row.value = val
        else:
            db.add(models.Setting(key=key, value=val))
    db.add(models.AuditLog(
        timestamp=datetime.utcnow(), username="admin",
        action="UPDATE_SETTINGS",
        details=f"Settings updated – Ping: {settings_in.ping_interval}s, Metrics: {settings_in.metrics_interval}s.",
        level="INFO"
    ))
    db.commit()
    return {"message": "Settings updated successfully"}


# ---------------------------------------------------------------
# Incidents
# ---------------------------------------------------------------
@app.get("/api/incidents")
def list_incidents(db: Session = Depends(get_config_db)):
    return [i.to_dict() for i in db.query(models.Incident).order_by(models.Incident.detectedTime.desc()).all()]

@app.put("/api/incidents/{incident_id}/acknowledge")
def acknowledge_incident(incident_id: str, db: Session = Depends(get_config_db)):
    incident = db.query(models.Incident).filter(models.Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found.")
    incident.status = "acknowledged"
    incident.lastUpdated = datetime.utcnow()
    incident.details += f"\nAcknowledged by operator at {datetime.utcnow()}."
    db.add(models.AuditLog(
        timestamp=datetime.utcnow(), username="admin",
        action="INCIDENT_ACKNOWLEDGED", device_host=incident.device_host,
        details=f"Ticket {incident_id} acknowledged.", level="INFO"
    ))
    db.commit()
    return {"message": "Incident acknowledged", "id": incident_id}

@app.put("/api/incidents/{incident_id}/resolve")
def resolve_incident(incident_id: str, db: Session = Depends(get_config_db)):
    incident = db.query(models.Incident).filter(models.Incident.id == incident_id).first()
    if not incident:
        raise HTTPException(status_code=404, detail="Incident not found.")
    incident.status = "resolved"
    incident.resolvedTime = datetime.utcnow()
    incident.lastUpdated = datetime.utcnow()
    incident.details += f"\nResolved by operator at {datetime.utcnow()}."
    db.add(models.AuditLog(
        timestamp=datetime.utcnow(), username="admin",
        action="INCIDENT_RESOLVED", device_host=incident.device_host,
        details=f"Ticket {incident_id} resolved.", level="INFO"
    ))
    db.commit()
    return {"message": "Incident resolved", "id": incident_id}


# ---------------------------------------------------------------
# Devices
# ---------------------------------------------------------------
@app.get("/api/devices")
def list_devices(db: Session = Depends(get_config_db)):
    bqm = BackupQueueManager()
    result = []
    for d in db.query(models.Device).all():
        item = d.to_dict()
        item["is_locked"] = bqm.is_locked(d.host)
        result.append(item)
    return result

@app.post("/api/devices")
def create_device(device_in: DeviceCreate, db: Session = Depends(get_config_db)):
    if db.query(models.Device).filter(models.Device.host == device_in.host).first():
        raise HTTPException(status_code=400, detail="Device with this IP already exists.")

    validate_snmp_fields(device_in)



    device = models.Device(
        name=device_in.name, host=device_in.host,
        device_type=device_in.device_type, username=device_in.username,
        password_encrypted=encrypt_value(device_in.password),
        secret_encrypted=encrypt_value(device_in.secret or device_in.password),
        is_monitored=device_in.is_monitored, region=device_in.region,
        status="UNKNOWN",

        # SNMP
        snmp_version=device_in.snmp_version.lower(),
        snmp_port=device_in.snmp_port,
        snmp_timeout=device_in.snmp_timeout,
        snmp_retries=device_in.snmp_retries,
        snmp_community_encrypted=encrypt_value(device_in.snmp_community) if device_in.snmp_community else None,
        snmp_username=device_in.snmp_username,
        snmp_auth_protocol=device_in.snmp_auth_protocol.upper() if device_in.snmp_auth_protocol else None,
        snmp_auth_password_encrypted=encrypt_value(device_in.snmp_auth_password) if device_in.snmp_auth_password else None,
        snmp_priv_protocol=device_in.snmp_priv_protocol.upper() if device_in.snmp_priv_protocol else None,
        snmp_priv_password_encrypted=encrypt_value(device_in.snmp_priv_password) if device_in.snmp_priv_password else None,
    )
    db.add(device)
    db.add(models.AuditLog(
        action="ADD_DEVICE", device_host=device_in.host,
        details=f"Device {device_in.name} ({device_in.region}) added. SNMP {device_in.snmp_version}.", level="INFO"
    ))
    db.commit()
    return {"message": "Device created", "host": device_in.host}

@app.put("/api/devices/{device_id}")
def update_device(device_id: int, device_in: DeviceUpdate, db: Session = Depends(get_config_db)):
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if device_in.name is not None:        device.name = device_in.name
    if device_in.host is not None:        device.host = device_in.host
    if device_in.device_type is not None: device.device_type = device_in.device_type
    if device_in.username is not None:    device.username = device_in.username
    if device_in.password is not None:    device.password_encrypted = encrypt_value(device_in.password)
    if device_in.secret is not None:      device.secret_encrypted = encrypt_value(device_in.secret)
    if device_in.is_monitored is not None: device.is_monitored = device_in.is_monitored
    if device_in.region is not None:      device.region = device_in.region

    # SSH
    if device_in.ssh_enabled is not None:  device.ssh_enabled = device_in.ssh_enabled

    # SNMP
    if device_in.snmp_version is not None:
        if device_in.snmp_version.lower() not in ("v2c", "v3"):
            raise HTTPException(status_code=400, detail="snmp_version must be 'v2c' or 'v3'.")
        device.snmp_version = device_in.snmp_version.lower()
    if device_in.snmp_port is not None:    device.snmp_port = device_in.snmp_port
    if device_in.snmp_timeout is not None: device.snmp_timeout = device_in.snmp_timeout
    if device_in.snmp_retries is not None: device.snmp_retries = device_in.snmp_retries
    if device_in.snmp_community is not None:
        device.snmp_community_encrypted = encrypt_value(device_in.snmp_community)
    if device_in.snmp_username is not None: device.snmp_username = device_in.snmp_username
    if device_in.snmp_auth_protocol is not None:
        if device_in.snmp_auth_protocol.upper() not in VALID_SNMP_AUTH_PROTOCOLS:
            raise HTTPException(status_code=400, detail="Authentication Protocol must be MD5, SHA, or SHA-256.")
        device.snmp_auth_protocol = device_in.snmp_auth_protocol.upper()
    if device_in.snmp_auth_password is not None:
        device.snmp_auth_password_encrypted = encrypt_value(device_in.snmp_auth_password)
    if device_in.snmp_priv_protocol is not None:
        if device_in.snmp_priv_protocol.upper() not in VALID_SNMP_PRIV_PROTOCOLS:
            raise HTTPException(status_code=400, detail="Privacy Protocol must be DES or AES.")
        device.snmp_priv_protocol = device_in.snmp_priv_protocol.upper()
    if device_in.snmp_priv_password is not None:
        device.snmp_priv_password_encrypted = encrypt_value(device_in.snmp_priv_password)



    db.add(models.AuditLog(action="UPDATE_DEVICE", device_host=device.host,
                           details=f"Device {device.name} updated.", level="INFO"))
    db.commit()
    return {"message": "Device updated"}


# ---------------------------------------------------------------
# Credential Testing (req 3.3)
# ---------------------------------------------------------------
class ConnectionTestRequest(BaseModel):
    host: str
    device_type: str = "cisco_ios"
    username: str
    password: str
    port: int = 22
    secret: Optional[str] = None


def _run_ssh_connection_test(host: str, device_type: str, username: str, password: str,
                              port: int, secret: Optional[str] = None) -> Dict:
    """Attempts an SSH login and returns a standardized result (req 3.3)."""
    from netmiko import ConnectHandler
    from netmiko.exceptions import NetmikoTimeoutException, NetmikoAuthenticationException

    if not _check_tcp_port(host, port, timeout=3.0):
        return {"result": "Device Unreachable", "success": False,
                "detail": f"No response on {host}:{port}."}

    try:
        conn = ConnectHandler(
            device_type=device_type,
            host=host,
            username=username,
            password=password,
            secret=secret or password,
            port=port,
            timeout=config.CONNECTION_TIMEOUT,
            fast_cli=False,
        )
        conn.disconnect()
        return {"result": "Connection Successful", "success": True, "detail": "SSH authentication succeeded."}
    except NetmikoAuthenticationException:
        return {"result": "Authentication Failed", "success": False, "detail": "Invalid username or password."}
    except NetmikoTimeoutException:
        return {"result": "Device Unreachable", "success": False, "detail": "Connection timed out."}
    except Exception as e:
        return {"result": "Device Unreachable", "success": False, "detail": str(e)}


def _check_tcp_port(host: str, port: int, timeout: float = 2.0) -> bool:
    import socket
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


@app.post("/api/devices/test-connection")
def test_connection(req: ConnectionTestRequest):
    """Verify SSH credentials before saving a new device (req 3.3)."""
    return _run_ssh_connection_test(
        req.host, req.device_type, req.username, req.password, req.port, req.secret
    )


@app.post("/api/devices/{device_id}/test-connection")
def test_device_connection(device_id: int, db: Session = Depends(get_config_db)):
    """Verify the SSH credentials already stored for an existing device (req 3.3 / 5.2)."""
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    ssh_user = device.username
    ssh_pass = decrypt_value(device.password_encrypted)
    secret = decrypt_value(device.secret_encrypted) if device.secret_encrypted else None

    outcome = _run_ssh_connection_test(device.host, device.device_type, ssh_user, ssh_pass, 22, secret)

    now = datetime.utcnow()
    if outcome["success"]:
        device.ssh_status = "ONLINE"
        device.ssh_last_connected = now
    elif outcome["result"] == "Authentication Failed":
        device.ssh_status = "AUTH_FAILED"
        device.ssh_last_failed = now
    else:
        device.ssh_status = "OFFLINE"
        device.ssh_last_failed = now

    db.add(models.AuditLog(
        action="SSH_LOGIN_SUCCESS" if outcome["success"] else "SSH_LOGIN_FAILURE",
        device_host=device.host,
        details=f"Test connection: {outcome['result']}.",
        level="INFO" if outcome["success"] else "WARNING"
    ))
    db.commit()
    return outcome

@app.delete("/api/devices/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_config_db)):
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    db.add(models.AuditLog(action="DELETE_DEVICE", device_host=device.host,
                           details=f"Device {device.name} removed.", level="WARNING"))
    db.delete(device)
    db.commit()
    return {"message": "Device deleted"}


# ---------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------
@app.get("/api/devices/{host}/metrics")
def get_device_metrics(host: str, limit: int = 50, db: Session = Depends(get_metrics_db)):
    metrics = db.query(models.Metric).filter(
        models.Metric.device_host == host
    ).order_by(models.Metric.timestamp.desc()).limit(limit).all()
    metrics.reverse()
    return [
        {"timestamp": m.timestamp, "latency": m.latency, "packet_loss": m.packet_loss,
         "cpu": m.cpu_utilization, "memory": m.memory_utilization}
        for m in metrics
    ]

@app.get("/api/metrics/regions")
def get_regional_metrics(db: Session = Depends(get_config_db), m_db: Session = Depends(get_metrics_db)):
    devices = db.query(models.Device).filter(models.Device.is_monitored == True).all()
    if not devices:
        return []

    regions_map: Dict[str, list] = {}
    for d in devices:
        regions_map.setdefault(d.region, []).append(d)

    now = datetime.utcnow()
    ten_min_ago = now - timedelta(minutes=10)
    day_ago = now - timedelta(hours=24)
    results = []

    for r_name, r_devices in regions_map.items():
        hosts = [d.host for d in r_devices]
        online = [d for d in r_devices if d.status in ("UP", "DEGRADED")]
        online_latencies = [d.last_latency for d in online if d.last_latency > 0]
        avg_latency = round(sum(online_latencies) / len(online_latencies), 1) if online_latencies else 0.0
        max_latency = round(max(online_latencies), 1) if online_latencies else 0.0

        failed_backups = db.query(models.Backup).filter(
            models.Backup.device_host.in_(hosts),
            models.Backup.timestamp >= day_ago,
            models.Backup.status == "FAILED"
        ).count()

        offline_count = len(r_devices) - len(online)

        # Only flag health issues when actual monitoring data exists
        has_real_data = bool(history_metrics)
        health_status = "Unknown"
        if has_real_data:
            health_status = "Healthy"
            if offline_count > 0 or failed_backups > 0:
                health_status = "Warning"
            if offline_count > 1 or avg_latency > 50.0:
                health_status = "Critical"

        history_metrics = m_db.query(models.Metric).filter(
            models.Metric.device_host.in_(hosts),
            models.Metric.timestamp >= ten_min_ago
        ).order_by(models.Metric.timestamp.asc()).all()

        bins: Dict[int, list] = {}
        for hm in history_metrics:
            ts_bin = int(hm.timestamp.timestamp() // 30) * 30
            if hm.latency > 0:
                bins.setdefault(ts_bin, []).append(hm.latency)

        sparkline = [round(sum(v)/len(v), 1) for v in [bins[k] for k in sorted(bins)]][-10:]
        # Only include sparkline when there is real data
        if not sparkline:
            sparkline = []

        results.append({
            "region": r_name,
            "avg_latency": avg_latency, "max_latency": max_latency,
            "devices_count": len(r_devices), "online_count": len(online),
            "offline_count": offline_count, "health_status": health_status,
            "sparkline": sparkline,
            "top_5_devices": [{"name": d.name, "host": d.host, "latency": d.last_latency,
                                "is_online": d.status != "DOWN"} for d in r_devices[:5]],
            "offline_devices": [d.name for d in r_devices if d.status == "DOWN"],
            "backup_failures_24h": failed_backups
        })

    return results


# ---------------------------------------------------------------
# Backups
# ---------------------------------------------------------------
def run_background_backup(host: str, username: str, client_ip: str):
    execute_device_backup(host, triggered_by=username, source_ip=client_ip)

@app.post("/api/devices/{host}/backup")
def trigger_backup(host: str, background_tasks: BackgroundTasks):
    background_tasks.add_task(run_background_backup, host, "admin", "127.0.0.1")
    return {"message": f"Backup queued for {host}."}

@app.post("/api/backup/all")
def trigger_backup_all(background_tasks: BackgroundTasks, db: Session = Depends(get_config_db)):
    bqm = BackupQueueManager()
    monitored = db.query(models.Device).filter(models.Device.is_monitored == True).all()
    queued = []
    for d in monitored:
        if not bqm.is_locked(d.host):
            background_tasks.add_task(run_background_backup, d.host, "admin", "127.0.0.1")
            queued.append(d.host)
    db.add(models.AuditLog(
        action="TRIGGER_BULK_BACKUP",
        details=f"Bulk backup queued for {len(queued)} devices.", level="INFO"
    ))
    db.commit()
    return {"message": f"Backup queued for {len(queued)} devices.", "queued_devices": queued}

@app.get("/api/backups")
def get_backups_list(db: Session = Depends(get_config_db)):
    backups = db.query(models.Backup).order_by(models.Backup.timestamp.desc()).limit(1000).all()
    return [b.to_dict() for b in backups]

@app.get("/api/backups/download/{backup_id}")
def download_backup_file(backup_id: int, db: Session = Depends(get_config_db)):
    backup = db.query(models.Backup).filter(models.Backup.id == backup_id).first()
    if not backup or backup.status != "SUCCESS":
        raise HTTPException(status_code=404, detail="Backup file not found.")
    if not os.path.exists(backup.file_path):
        raise HTTPException(status_code=404, detail="File no longer exists on server.")
    return FileResponse(path=backup.file_path, media_type="application/gzip",
                        filename=backup.file_name)

@app.get("/api/backups/download-zip")
def download_all_backups_zip(db: Session = Depends(get_config_db)):
    devices = db.query(models.Device).all()
    buf = io.BytesIO()
    added = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dev in devices:
            latest = db.query(models.Backup).filter(
                models.Backup.device_host == dev.host,
                models.Backup.status == "SUCCESS"
            ).order_by(models.Backup.timestamp.desc()).first()
            if latest and latest.file_path and os.path.exists(latest.file_path):
                if latest.file_path not in added:
                    added.add(latest.file_path)
                    zf.write(latest.file_path, arcname=latest.file_name)
    if not added:
        raise HTTPException(status_code=404, detail="No backup files to archive.")
    buf.seek(0)
    db.add(models.AuditLog(action="DOWNLOAD_ALL_BACKUPS_ZIP",
                           details=f"Exported {len(added)} configs as ZIP.", level="INFO"))
    db.commit()
    return StreamingResponse(buf, media_type="application/zip",
                             headers={"Content-Disposition": "attachment; filename=bpcl_configs.zip"})


# ---------------------------------------------------------------
# Audit Logs
# ---------------------------------------------------------------
@app.get("/api/audit-logs")
def get_audit_logs(db: Session = Depends(get_config_db)):
    logs = db.query(models.AuditLog).order_by(models.AuditLog.timestamp.desc()).limit(150).all()
    return [l.to_dict() for l in logs]


# ---------------------------------------------------------------
# Stats
# ---------------------------------------------------------------
@app.get("/api/stats")
def get_dashboard_stats(db: Session = Depends(get_config_db), m_db: Session = Depends(get_metrics_db)):
    devices = db.query(models.Device).all()
    total = len(devices)
    up = sum(1 for d in devices if d.status == "UP")
    degraded = sum(1 for d in devices if d.status == "DEGRADED")
    down = sum(1 for d in devices if d.status == "DOWN")
    unknown = sum(1 for d in devices if d.status == "UNKNOWN")

    online_devices = [d for d in devices if d.status in ("UP", "DEGRADED")]
    online_lats = [d.last_latency for d in online_devices if d.last_latency > 0]
    avg_latency = round(sum(online_lats) / len(online_lats), 1) if online_lats else None

    day_ago = datetime.utcnow() - timedelta(days=1)
    day_backups = db.query(models.Backup).filter(models.Backup.timestamp >= day_ago).all()
    b_total   = len(day_backups)
    b_success = sum(1 for b in day_backups if b.status == "SUCCESS")
    b_failed  = sum(1 for b in day_backups if b.status == "FAILED")
    b_rate    = round((b_success/b_total)*100.0, 1) if b_total > 0 else 100.0

    cpu_list = [d.last_cpu    for d in devices if d.last_cpu    > 0]
    mem_list = [d.last_memory for d in devices if d.last_memory > 0]
    avg_cpu = round(sum(cpu_list)/len(cpu_list), 1) if cpu_list else 0.0
    avg_mem = round(sum(mem_list)/len(mem_list), 1) if mem_list else 0.0

    active_incidents = db.query(models.Incident).filter(models.Incident.status != "resolved").count()

    # Telemetry status indicator
    has_any_metrics = m_db.query(models.Metric).filter(models.Metric.is_mocked == False).count() > 0
    all_monitored = db.query(models.Device).filter(models.Device.is_monitored == True).count()
    if not has_any_metrics:
        telemetry_status = "no_telemetry"
    elif up == 0 and all_monitored > 0:
        telemetry_status = "device_unreachable"
    else:
        telemetry_status = "real_time"

    # Environmental health summary counts (new)
    fan_failures    = db.query(models.Incident).filter(
        models.Incident.status != "resolved",
        models.Incident.component_type == "FAN",
    ).count()
    psu_failures    = db.query(models.Incident).filter(
        models.Incident.status != "resolved",
        models.Incident.component_type == "POWER_SUPPLY",
    ).count()
    thermal_alerts  = db.query(models.Incident).filter(
        models.Incident.status != "resolved",
        models.Incident.category == "Thermal",
    ).count()
    interface_incidents = db.query(models.Incident).filter(
        models.Incident.status != "resolved",
        models.Incident.category == "Interface",
    ).count()

    return {
        "devices": {
            "total": total,
            "up": up,
            "degraded": degraded,
            "down": down,
            "unknown": unknown,
            "online": up + degraded,
            "offline": down,
        },
        "averages": {
            "latency": avg_latency,
            "cpu": avg_cpu,
            "memory": avg_mem
        },
        "backups_24h": {"total": b_total, "success": b_success, "failed": b_failed, "success_rate": b_rate},
        "active_incidents": active_incidents,
        "telemetry_status": telemetry_status,
        "simulation_mode": False,
        "switch_health": {
            "fan_failures": fan_failures,
            "psu_failures": psu_failures,
            "thermal_alerts": thermal_alerts,
            "interface_incidents": interface_incidents,
        },
    }


# ---------------------------------------------------------------
# Backend Safeguards – reject mock / sample metrics (req 9)
# ---------------------------------------------------------------
class MetricIngest(BaseModel):
    device_host: str
    latency: float
    packet_loss: float
    cpu_utilization: float = 0.0
    memory_utilization: float = 0.0
    is_mocked: bool = False


@app.post("/api/metrics/ingest", status_code=201)
def ingest_metric(metric_in: MetricIngest, db: Session = Depends(get_metrics_db)):
    """Public metric ingestion endpoint.  Mocked/sample data is always rejected."""
    if metric_in.is_mocked:
        raise HTTPException(
            status_code=400,
            detail="Simulated/mocked metrics are rejected. Simulation mode is disabled."
        )
    # Sanity-check: latency must be non-negative
    if metric_in.latency < 0:
        raise HTTPException(status_code=400, detail="Latency cannot be negative.")

    db.add(models.Metric(
        device_host=metric_in.device_host,
        timestamp=datetime.utcnow(),
        latency=metric_in.latency,
        packet_loss=metric_in.packet_loss,
        cpu_utilization=metric_in.cpu_utilization,
        memory_utilization=metric_in.memory_utilization,
        is_mocked=False,
    ))
    db.commit()
    return {"message": "Metric recorded."}


# ---------------------------------------------------------------
# Telemetry Status Endpoint (req 8)
# ---------------------------------------------------------------
@app.get("/api/telemetry/status")
def get_telemetry_status(db: Session = Depends(get_config_db), m_db: Session = Depends(get_metrics_db)):
    """Returns a telemetry status indicator for the dashboard banner."""
    monitored = db.query(models.Device).filter(models.Device.is_monitored == True).all()
    if not monitored:
        return {"status": "no_telemetry", "label": "No Telemetry", "detail": "No monitored devices registered."}

    has_real = m_db.query(models.Metric).filter(models.Metric.is_mocked == False).count() > 0
    if not has_real:
        return {"status": "no_telemetry", "label": "Waiting for telemetry data.", "detail": "Monitoring is active but no results received yet."}

    online = sum(1 for d in monitored if d.status in ("UP", "DEGRADED"))
    if online == 0:
        return {"status": "device_unreachable", "label": "Device Unreachable", "detail": "All monitored devices are currently unreachable."}

    disabled = sum(1 for d in monitored if not d.is_monitored)
    if disabled == len(monitored):
        return {"status": "monitoring_disabled", "label": "Monitoring Disabled", "detail": "All devices have monitoring disabled."}

    return {"status": "real_time", "label": "Real-Time", "detail": f"{online}/{len(monitored)} devices online."}


# ---------------------------------------------------------------
# Health
# ---------------------------------------------------------------
@app.get("/api/health")
def health_check():
    return {"status": "healthy", "environment": config.ENVIRONMENT, "timestamp": datetime.utcnow()}


@app.websocket("/ws/packets")
async def ws_packets(websocket: WebSocket):
    await websocket.accept()

    sniffer = PacketSniffer(interface="Wi-Fi")

    try:
        async for pkt in sniffer.stream():
            await websocket.send_json(pkt)

    except Exception as e:
        print("WebSocket error:", e)

    finally:
        sniffer.stop()