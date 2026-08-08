"""
ssh_service.py
──────────────
Service layer for all SSH operations executed via Netmiko.
Credentials are NEVER passed over the wire; they are fetched from the
encrypted database on the backend and decrypted immediately before use.

Supported platforms:
  cisco_ios  │  arista_eos  │  hp_procurve  │  juniper_junos
"""

from __future__ import annotations

import logging
import re
import socket
from datetime import datetime
from typing import List, Dict, Any, Optional

from sqlalchemy.orm import Session

from db import models
from db.security import decrypt_value

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Commands that operators are allowed to run via the terminal tab.
#: Retained for backwards compatibility with callers that still reference
#: the curated preset list (e.g. the "/api/ssh/allowed-commands" endpoint).
ALLOWED_SHOW_COMMANDS: tuple[str, ...] = (
    "show ip interface brief",
    "show version",
    "show vlan brief",
    "show mac address-table",
    "show cdp neighbors",
    "show lldp neighbors",
    # aliases / abbreviations that IOS accepts:
    "show cdp neig",
    "show lldp neig",
    "show ip int br",
    "show ver",
    "show mac addr",
)

#: Configuration commands that are explicitly blocked regardless of context.
_BLOCKED_CONFIG_PATTERNS: tuple[str, ...] = (
    r"^no\s+service",          # e.g. no service password-encryption
    r"^reload",                # reloads the device
    r"^erase\s+startup",       # wipes startup config
    r"^format\s+",             # filesystem format
    r"^write\s+erase",         # wipes startup config
    r"^delete\s+",             # deletes files
    r"^crypto\s+key\s+zeroize",# destroys crypto keys
)

#: Operational commands typed into the real-CLI terminal are validated
#: against this blacklist instead of a whitelist. Any command that is NOT
#: covered by one of these patterns is allowed to execute. This list
#: targets destructive, disruptive, or device-altering operations.
BLOCKED_TERMINAL_PATTERNS: tuple[str, ...] = (
    r"^reload\b",                  # reloads / reboots the device
    r"^write\s+erase\b",            # wipes startup config
    r"^erase\b",                    # erase startup-config / flash / nvram
    r"^format\b",                   # filesystem format
    r"^delete\b",                   # deletes files from flash/disk
    r"^clear\b",                    # clears counters, ARP, routes, sessions, etc.
    r"^copy\b",                     # copy running/startup config, TFTP transfers
    r"^configure\b",                # enter global configuration mode
    r"^conf\s*t",                   # "conf t" abbreviation for config mode
    r"^no\s+",                      # any "no <something>" negation command
    r"^shutdown\b",                 # interface/device shutdown
    r"^crypto\s+key\s+zeroize",     # destroys crypto keys
    r"^write\b",                    # write memory / write erase
    r"^debug\b",                    # debug commands can overload the device
    r"^undebug\b",
    r"^request\s+system\s+reboot",  # Juniper reboot
    r"^request\s+system\s+halt",    # Juniper halt
    r"^request\s+vmhost\s+reboot",
    r"^monitor\s+",                 # long-running interactive monitors
    r"^test\s+",                    # interface/cable diagnostics that can flap links
    r"^reset\b",                    # Arista/Juniper reset operations
    r"^restart\b",
    r"^kill\b",
)


def _is_command_blocked(command: str) -> Optional[str]:
    """
    Return a human-readable reason if *command* matches the destructive
    operations blacklist, else None.

    Matching is case-insensitive and based on the leading keyword(s) of the
    command so that arguments (interface names, VLAN IDs, etc.) do not
    affect the decision.
    """
    stripped = command.strip().lower()
    if not stripped:
        return "Command must not be empty."

    for pattern in BLOCKED_TERMINAL_PATTERNS:
        if re.search(pattern, stripped):
            return (
                f"Command '{command.strip()}' is blocked. Destructive or "
                "configuration-altering commands are not permitted from the "
                "operational terminal."
            )
    return None

SSH_TIMEOUT: int = 15          # seconds for connection + command
TCP_PRE_CHECK_TIMEOUT: float = 3.0


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _tcp_reachable(host: str, port: int, timeout: float = TCP_PRE_CHECK_TIMEOUT) -> bool:
    """Quick TCP port check before attempting full SSH handshake."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _classify_netmiko_error(exc: Exception) -> Dict[str, Any]:
    """Map a Netmiko / socket exception to a structured error dict."""
    exc_name = type(exc).__name__
    msg = str(exc)

    if "NetmikoAuthenticationException" in exc_name or "Authentication" in msg:
        return {
            "success": False,
            "error_type": "AUTH_FAILED",
            "output": "",
            "error": "SSH authentication failed. Verify the username, password, and enable secret stored for this device.",
        }
    if "NetmikoTimeoutException" in exc_name or "timed out" in msg.lower():
        return {
            "success": False,
            "error_type": "TIMEOUT",
            "output": "",
            "error": "SSH connection timed out. The device did not respond within the allowed window.",
        }
    return {
        "success": False,
        "error_type": "GENERIC",
        "output": "",
        "error": f"SSH error ({exc_name}): {msg}",
    }


def _validate_config_commands(commands: List[str]) -> Optional[str]:
    """
    Return an error string if any command is blocked, else None.
    This is a defence-in-depth measure; the main gate is RBAC on the API.
    """
    for cmd in commands:
        stripped = cmd.strip().lower()
        if not stripped:
            continue
        for pattern in _BLOCKED_CONFIG_PATTERNS:
            if re.search(pattern, stripped):
                return (
                    f"Blocked command detected: '{cmd.strip()}'. "
                    "Destructive operations (reload, erase, delete) are not permitted."
                )
    return None


def _fetch_device_credentials(device: models.Device) -> Dict[str, Any]:
    """
    Decrypt and assemble the Netmiko connection dictionary.
    Raises ValueError if the device has no usable credentials.
    """
    username = device.username or ""
    password = decrypt_value(device.password_encrypted) if device.password_encrypted else ""
    secret = decrypt_value(device.secret_encrypted) if device.secret_encrypted else password

    if not username or not password:
        raise ValueError(
            "This device has no SSH credentials configured. "
            "Please update the device credentials via System Settings."
        )

    return {
        "device_type": device.device_type or "cisco_ios",
        "host": device.host,
        "username": username,
        "password": password,
        "secret": secret or password,
        "port": 22,
        "timeout": SSH_TIMEOUT,
        "fast_cli": False,
        "session_log": None,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def execute_terminal_command(
    device: models.Device,
    command: str,
    db: Session,
    username: str = "admin",
) -> Dict[str, Any]:
    """
    Connect to *device* over SSH and run a single operator-entered command
    for the "Real CLI" terminal.

    Unlike :func:`execute_show_command`, this entry point does NOT restrict
    callers to a fixed whitelist of "show" commands. Instead, every command
    is checked against ``BLOCKED_TERMINAL_PATTERNS`` — a blacklist of
    destructive / configuration-altering operations (reload, erase, copy,
    configure terminal, clear, debug, etc.). Anything not matched by the
    blacklist is treated as a permitted operational command and sent to the
    device as-is.

    Returns
    -------
    {
        "success": bool,
        "output": str,          # raw CLI output
        "error": str | None,
        "error_type": str | None,
        "executed_at": str,     # ISO-8601 timestamp
        "device_name": str,
        "device_host": str,
        "command": str,
        "prompt": str,          # device CLI prompt, e.g. "switch1#"
    }
    """
    # Lazy import so Netmiko is only pulled when actually used
    from netmiko import ConnectHandler  # type: ignore
    from netmiko.exceptions import (  # type: ignore
        NetmikoAuthenticationException,
        NetmikoTimeoutException,
    )

    executed_at = datetime.utcnow().isoformat()
    base = {
        "executed_at": executed_at,
        "device_name": device.name,
        "device_host": device.host,
        "command": command,
        "prompt": "",
    }

    # 1. Blacklist check — block destructive / configuration-altering commands
    block_reason = _is_command_blocked(command)
    if block_reason:
        _write_audit_log(
            db,
            action="SSH_COMMAND_BLOCKED",
            device_host=device.host,
            details=f"Operator: {username} | Blocked command attempt: '{command.strip()}'",
            level="WARNING",
            username=username,
        )
        return {
            **base,
            "success": False,
            "output": "",
            "error": block_reason,
            "error_type": "BLOCKED",
        }

    # 2. TCP reachability pre-check
    if not _tcp_reachable(device.host, 22):
        _update_ssh_status(device, db, success=False, error_type="UNREACHABLE")
        return {
            **base,
            "success": False,
            "output": "",
            "error": f"Device {device.host} is unreachable on TCP/22.",
            "error_type": "UNREACHABLE",
        }

    # 3. Fetch and decrypt credentials
    try:
        conn_params = _fetch_device_credentials(device)
    except ValueError as exc:
        return {**base, "success": False, "output": "", "error": str(exc), "error_type": "NO_CREDENTIALS"}

    # 4. SSH + execute
    try:
        with ConnectHandler(**conn_params) as ssh:
            ssh.enable()
            prompt = ssh.find_prompt()
            output = ssh.send_command(
                command,
                read_timeout=SSH_TIMEOUT,
                strip_prompt=True,
                strip_command=True,
            )

        _update_ssh_status(device, db, success=True)
        _write_audit_log(
            db,
            action="SSH_COMMAND_EXECUTED",
            device_host=device.host,
            details=f"Operator: {username} | Command: '{command}' executed on {device.name}.",
            level="INFO",
            username=username,
        )
        return {**base, "success": True, "output": output, "error": None, "error_type": None, "prompt": prompt}

    except (NetmikoAuthenticationException, NetmikoTimeoutException, Exception) as exc:
        result = _classify_netmiko_error(exc)
        _update_ssh_status(device, db, success=False, error_type=result["error_type"])
        _write_audit_log(
            db,
            action="SSH_COMMAND_FAILED",
            device_host=device.host,
            details=f"Operator: {username} | Command: '{command}' failed – {result['error_type']}: {result['error'][:120]}",
            level="WARNING",
            username=username,
        )
        return {**base, **result}


def execute_show_command(
    device: models.Device,
    command: str,
    db: Session,
) -> Dict[str, Any]:
    """
    Connect to *device* over SSH and run a single show command.

    Returns
    -------
    {
        "success": bool,
        "output": str,          # raw CLI output
        "error": str | None,
        "error_type": str | None,
        "executed_at": str,     # ISO-8601 timestamp
        "device_name": str,
        "device_host": str,
        "command": str,
    }
    """
    # Lazy import so Netmiko is only pulled when actually used
    from netmiko import ConnectHandler  # type: ignore
    from netmiko.exceptions import (  # type: ignore
        NetmikoAuthenticationException,
        NetmikoTimeoutException,
    )

    executed_at = datetime.utcnow().isoformat()
    base = {
        "executed_at": executed_at,
        "device_name": device.name,
        "device_host": device.host,
        "command": command,
    }

    # 1. Validate command is in the allowed list
    normalised = command.strip().lower()
    if not any(normalised.startswith(allowed.lower()) for allowed in ALLOWED_SHOW_COMMANDS):
        return {
            **base,
            "success": False,
            "output": "",
            "error": f"Command '{command}' is not in the permitted command list.",
            "error_type": "BLOCKED",
        }

    # 2. TCP reachability pre-check
    if not _tcp_reachable(device.host, 22):
        _update_ssh_status(device, db, success=False, error_type="UNREACHABLE")
        return {
            **base,
            "success": False,
            "output": "",
            "error": f"Device {device.host} is unreachable on TCP/22.",
            "error_type": "UNREACHABLE",
        }

    # 3. Fetch and decrypt credentials
    try:
        conn_params = _fetch_device_credentials(device)
    except ValueError as exc:
        return {**base, "success": False, "output": "", "error": str(exc), "error_type": "NO_CREDENTIALS"}

    # 4. SSH + execute
    try:
        with ConnectHandler(**conn_params) as ssh:
            ssh.enable()
            output = ssh.send_command(command, read_timeout=SSH_TIMEOUT)

        _update_ssh_status(device, db, success=True)
        _write_audit_log(
            db,
            action="SSH_COMMAND_EXECUTED",
            device_host=device.host,
            details=f"Command: '{command}' executed on {device.name}.",
            level="INFO",
        )
        return {**base, "success": True, "output": output, "error": None, "error_type": None}

    except (NetmikoAuthenticationException, NetmikoTimeoutException, Exception) as exc:
        result = _classify_netmiko_error(exc)
        _update_ssh_status(device, db, success=False, error_type=result["error_type"])
        _write_audit_log(
            db,
            action="SSH_COMMAND_FAILED",
            device_host=device.host,
            details=f"Command: '{command}' failed – {result['error_type']}: {result['error'][:120]}",
            level="WARNING",
        )
        return {**base, **result}


def push_configuration(
    device: models.Device,
    commands: List[str],
    db: Session,
    operator: str = "admin",
) -> Dict[str, Any]:
    """
    Connect to *device* and push a list of configuration commands.

    Returns
    -------
    {
        "success": bool,
        "output": str,
        "error": str | None,
        "error_type": str | None,
        "executed_at": str,
        "device_name": str,
        "device_host": str,
        "commands_count": int,
    }
    """
    from netmiko import ConnectHandler  # type: ignore
    from netmiko.exceptions import (  # type: ignore
        NetmikoAuthenticationException,
        NetmikoTimeoutException,
    )

    executed_at = datetime.utcnow().isoformat()
    clean_commands = [c.strip() for c in commands if c.strip()]
    base = {
        "executed_at": executed_at,
        "device_name": device.name,
        "device_host": device.host,
        "commands_count": len(clean_commands),
    }

    # 1. Guard: must have at least one command
    if not clean_commands:
        return {**base, "success": False, "output": "", "error": "No commands provided.", "error_type": "EMPTY_INPUT"}

    # 2. Guard: blocked command patterns
    block_msg = _validate_config_commands(clean_commands)
    if block_msg:
        return {**base, "success": False, "output": "", "error": block_msg, "error_type": "BLOCKED"}

    # 3. TCP reachability
    if not _tcp_reachable(device.host, 22):
        _update_ssh_status(device, db, success=False, error_type="UNREACHABLE")
        return {**base, "success": False, "output": "", "error": f"Device {device.host} is unreachable on TCP/22.", "error_type": "UNREACHABLE"}

    # 4. Credentials
    try:
        conn_params = _fetch_device_credentials(device)
    except ValueError as exc:
        return {**base, "success": False, "output": "", "error": str(exc), "error_type": "NO_CREDENTIALS"}

    # 5. SSH + config push
    try:
        with ConnectHandler(**conn_params) as ssh:
            ssh.enable()
            output = ssh.send_config_set(clean_commands)

        _update_ssh_status(device, db, success=True)
        cmd_preview = "; ".join(clean_commands[:3])
        if len(clean_commands) > 3:
            cmd_preview += f" … (+{len(clean_commands) - 3} more)"
        _write_audit_log(
            db,
            action="CONFIG_PUSH_SUCCESS",
            device_host=device.host,
            details=f"Operator: {operator} | {len(clean_commands)} commands deployed. Preview: {cmd_preview}",
            level="INFO",
        )
        return {**base, "success": True, "output": output, "error": None, "error_type": None}

    except (NetmikoAuthenticationException, NetmikoTimeoutException, Exception) as exc:
        result = _classify_netmiko_error(exc)
        _update_ssh_status(device, db, success=False, error_type=result["error_type"])
        _write_audit_log(
            db,
            action="CONFIG_PUSH_FAILED",
            device_host=device.host,
            details=f"Operator: {operator} | Config push failed – {result['error_type']}: {result['error'][:120]}",
            level="ERROR",
        )
        return {**base, **result}


# ---------------------------------------------------------------------------
# Side-effect helpers (DB writes)
# ---------------------------------------------------------------------------

def _update_ssh_status(
    device: models.Device,
    db: Session,
    success: bool,
    error_type: Optional[str] = None,
) -> None:
    """Keep ssh_status / ssh_last_connected / ssh_last_failed in sync."""
    now = datetime.utcnow()
    if success:
        device.ssh_status = "ONLINE"
        device.ssh_last_connected = now
    elif error_type == "AUTH_FAILED":
        device.ssh_status = "AUTH_FAILED"
        device.ssh_last_failed = now
    else:
        device.ssh_status = "OFFLINE"
        device.ssh_last_failed = now
    try:
        db.commit()
    except Exception as exc:
        logger.warning("Failed to persist SSH status update: %s", exc)
        db.rollback()


def _write_audit_log(
    db: Session,
    action: str,
    device_host: str,
    details: str,
    level: str = "INFO",
    username: str = "admin",
) -> None:
    """Insert an AuditLog row, matching the existing logging pattern in main.py."""
    try:
        db.add(
            models.AuditLog(
                timestamp=datetime.utcnow(),
                username=username,
                action=action,
                device_host=device_host,
                details=details,
                level=level,
            )
        )
        db.commit()
    except Exception as exc:
        logger.warning("Failed to write audit log entry: %s", exc)
        db.rollback()
