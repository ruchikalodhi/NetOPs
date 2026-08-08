from datetime import datetime
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime
from db.database import Base

class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    host = Column(String, unique=True, index=True, nullable=False)
    device_type = Column(String, default="cisco_ios")
    username = Column(String, nullable=False)
    password_encrypted = Column(String, nullable=False)
    secret_encrypted = Column(String, nullable=False)
    status = Column(String, default="UNKNOWN")  # UP, DEGRADED, DOWN, UNKNOWN
    last_seen = Column(DateTime, nullable=True)
    last_latency = Column(Float, default=0.0)
    last_packet_loss = Column(Float, default=0.0)
    last_cpu = Column(Float, default=0.0)
    last_memory = Column(Float, default=0.0)
    is_monitored = Column(Boolean, default=True)
    region = Column(String, default="Default", nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

    # --- Device classification (set during discovery) ---
    device_classification = Column(String, nullable=True)  # Router/Switch/Firewall/AP/WLC/Server/Unknown

    # --- SSH credentials ---
    ssh_enabled = Column(Boolean, default=False, nullable=False)
    ssh_status = Column(String, default="UNKNOWN")
    ssh_last_connected = Column(DateTime, nullable=True)
    ssh_last_failed = Column(DateTime, nullable=True)

    # --- SNMP configuration ---
    snmp_version = Column(String, default="v2c", nullable=False)
    snmp_port = Column(Integer, default=161, nullable=False)
    snmp_timeout = Column(Integer, default=5, nullable=False)
    snmp_retries = Column(Integer, default=1, nullable=False)
    snmp_community_encrypted = Column(String, nullable=True)
    snmp_username = Column(String, nullable=True)
    snmp_auth_protocol = Column(String, nullable=True)
    snmp_auth_password_encrypted = Column(String, nullable=True)
    snmp_priv_protocol = Column(String, nullable=True)
    snmp_priv_password_encrypted = Column(String, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "host": self.host,
            "device_type": self.device_type,
            "username": self.username,
            "status": self.status,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "last_latency": self.last_latency,
            "last_packet_loss": self.last_packet_loss,
            "last_cpu": self.last_cpu,
            "last_memory": self.last_memory,
            "is_monitored": self.is_monitored,
            "region": self.region,
            "simulation_mode": False,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "ssh_enabled": self.ssh_enabled,
            "ssh_status": self.ssh_status,
            "ssh_last_connected": self.ssh_last_connected.isoformat() if self.ssh_last_connected else None,
            "ssh_last_failed": self.ssh_last_failed.isoformat() if self.ssh_last_failed else None,
            "snmp_version": self.snmp_version,
            "snmp_port": self.snmp_port,
            "snmp_timeout": self.snmp_timeout,
            "snmp_retries": self.snmp_retries,
            "snmp_community_set": bool(self.snmp_community_encrypted),
            "snmp_username": self.snmp_username,
            "snmp_auth_protocol": self.snmp_auth_protocol,
            "snmp_auth_password_set": bool(self.snmp_auth_password_encrypted),
            "snmp_priv_protocol": self.snmp_priv_protocol,
            "snmp_priv_password_set": bool(self.snmp_priv_password_encrypted),
            "device_classification": self.device_classification,
        }


class Backup(Base):
    __tablename__ = "backups"

    id = Column(Integer, primary_key=True, index=True)
    device_host = Column(String, index=True, nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow)
    file_name = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    config_hash = Column(String, nullable=False)
    status = Column(String, nullable=False)
    error_message = Column(String, nullable=True)
    execution_time = Column(Float, default=0.0)
    device_name = Column(String, nullable=True)
    device_type = Column(String, nullable=True)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    triggered_by = Column(String, nullable=True)

    def to_dict(self):
        return {
            "id": self.id,
            "device_host": self.device_host,
            "device_name": self.device_name,
            "device_type": self.device_type,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "end_time": self.end_time.isoformat() if self.end_time else None,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "file_name": self.file_name,
            "file_path": self.file_path,
            "config_hash": self.config_hash,
            "status": self.status,
            "error_message": self.error_message,
            "execution_time": self.execution_time,
            "triggered_by": self.triggered_by,
            "operator": self.triggered_by
        }


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime, default=datetime.utcnow)
    username = Column(String, default="system")
    action = Column(String, nullable=False)
    device_host = Column(String, nullable=True)
    source_ip = Column(String, nullable=True)
    details = Column(String, nullable=True)
    level = Column(String, default="INFO")

    def to_dict(self):
        return {
            "id": self.id,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "username": self.username,
            "action": self.action,
            "device_host": self.device_host,
            "source_ip": self.source_ip,
            "details": self.details,
            "level": self.level
        }


class Metric(Base):
    __tablename__ = "metrics"

    id = Column(Integer, primary_key=True, index=True)
    device_host = Column(String, index=True, nullable=False)
    timestamp = Column(DateTime, index=True, default=datetime.utcnow)
    latency = Column(Float, default=0.0)
    packet_loss = Column(Float, default=0.0)
    cpu_utilization = Column(Float, default=0.0)
    memory_utilization = Column(Float, default=0.0)
    is_mocked = Column(Boolean, default=False)

    def to_dict(self):
        return {
            "id": self.id,
            "device_host": self.device_host,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None,
            "latency": self.latency,
            "packet_loss": self.packet_loss,
            "cpu_utilization": self.cpu_utilization,
            "memory_utilization": self.memory_utilization,
            "is_mocked": self.is_mocked
        }


class Incident(Base):
    """
    Extended Incident model supporting environmental, interface, hardware,
    power, and thermal events in addition to the original connectivity incidents.

    Backward-compatible: all new columns are nullable with safe defaults.
    """
    __tablename__ = "incidents"

    id = Column(String, primary_key=True)            # TK-YYYY-XXXXX
    device_host = Column(String, index=True, nullable=False)
    deviceName = Column(String, nullable=False)
    detectedTime = Column(DateTime, default=datetime.utcnow)
    severity = Column(String, default="medium")      # critical, major, medium, minor, warning, low
    status = Column(String, default="open")          # open, acknowledged, resolved
    resolvedTime = Column(DateTime, nullable=True)
    lastUpdated = Column(DateTime, default=datetime.utcnow)
    details = Column(String, nullable=True)

    # ── New: Incident categorisation ──────────────────────────────────────
    category = Column(String, default="Connectivity", nullable=True)
    # Connectivity | Environmental | Interface | Hardware | Power | Thermal | Security

    event_source = Column(String, default="PING", nullable=True)
    # PING | SNMP_TRAP | SNMP_POLL | SSH_POLL

    # ── New: Hardware / Environmental context ─────────────────────────────
    component_type = Column(String, nullable=True)
    # FAN | POWER_SUPPLY | TEMPERATURE_SENSOR | POWER_SYSTEM | MODULE | SUPERVISOR | SYSTEM

    component_name = Column(String, nullable=True)   # e.g. "Fan 2", "PSU 1"
    hardware_sensor = Column(String, nullable=True)  # raw OID or sensor label
    threshold_value = Column(Float, nullable=True)   # configured threshold
    actual_value = Column(Float, nullable=True)      # measured value at alert time

    # ── New: Interface context ────────────────────────────────────────────
    interface_name = Column(String, nullable=True)        # e.g. Gi1/0/24
    interface_description = Column(String, nullable=True) # operator description
    interface_mode = Column(String, nullable=True)
    # Access | Trunk | Routed | Hybrid | Monitor/SPAN | Disabled

    interface_admin_state = Column(String, nullable=True)  # Up | Down
    interface_oper_state = Column(String, nullable=True)   # Up | Down | Err-disabled
    native_vlan = Column(String, nullable=True)
    allowed_vlans = Column(String, nullable=True)          # comma-separated
    port_channel = Column(String, nullable=True)           # e.g. Po1

    def to_dict(self):
        return {
            "id": self.id,
            "device_host": self.device_host,
            "deviceName": self.deviceName,
            "detectedTime": self.detectedTime.isoformat() if self.detectedTime else None,
            "severity": self.severity,
            "status": self.status,
            "resolvedTime": self.resolvedTime.isoformat() if self.resolvedTime else None,
            "lastUpdated": self.lastUpdated.isoformat() if self.lastUpdated else None,
            "details": self.details,
            # extended fields
            "category": self.category or "Connectivity",
            "event_source": self.event_source or "PING",
            "component_type": self.component_type,
            "component_name": self.component_name,
            "hardware_sensor": self.hardware_sensor,
            "threshold_value": self.threshold_value,
            "actual_value": self.actual_value,
            "interface_name": self.interface_name,
            "interface_description": self.interface_description,
            "interface_mode": self.interface_mode,
            "interface_admin_state": self.interface_admin_state,
            "interface_oper_state": self.interface_oper_state,
            "native_vlan": self.native_vlan,
            "allowed_vlans": self.allowed_vlans,
            "port_channel": self.port_channel,
        }


class DeviceLink(Base):
    """Stores discovered network topology relationships between devices."""
    __tablename__ = "device_links"

    id = Column(Integer, primary_key=True, index=True)
    source_device_id = Column(Integer, index=True, nullable=False)
    target_device_id = Column(Integer, index=True, nullable=False)
    local_interface = Column(String, nullable=True)
    remote_interface = Column(String, nullable=True)
    protocol = Column(String, default="LLDP")   # LLDP | CDP | LLDP+CDP
    last_seen = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "source_device_id": self.source_device_id,
            "target_device_id": self.target_device_id,
            "local_interface": self.local_interface,
            "remote_interface": self.remote_interface,
            "protocol": self.protocol,
            "last_seen": self.last_seen.isoformat() if self.last_seen else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="admin")
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "username": self.username,
            "role": self.role,
            "created_at": self.created_at.isoformat() if self.created_at else None
        }


class Setting(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True, nullable=False)
    value = Column(String, nullable=False)
    description = Column(String, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return {
            "id": self.id,
            "key": self.key,
            "value": self.value,
            "description": self.description,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None
        }
