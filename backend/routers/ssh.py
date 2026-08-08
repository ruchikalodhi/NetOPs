"""
routers/ssh.py
──────────────
FastAPI router that exposes the two SSH-operation endpoints:

  POST /api/ssh/command   – run a show command on a managed device
  POST /api/ssh/config    – push configuration commands to a managed device

Credentials are fetched from the existing device database and decrypted
server-side.  They are NEVER echoed back to the caller.
"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, validator
from sqlalchemy.orm import Session

from db.database import get_config_db
from db import models
from services.ssh_service import (
    ALLOWED_SHOW_COMMANDS,
    BLOCKED_TERMINAL_PATTERNS,
    execute_show_command,
    execute_terminal_command,
    push_configuration,
)

router = APIRouter(prefix="/api/ssh", tags=["SSH Operations"])


# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------

class CommandRequest(BaseModel):
    device_id: int
    command: str

    @validator("command")
    def command_not_empty(cls, v: str) -> str:  # noqa: N805
        v = v.strip()
        if not v:
            raise ValueError("command must not be empty")
        return v


class ConfigRequest(BaseModel):
    device_id: int
    commands: List[str]

    @validator("commands")
    def commands_not_empty(cls, v: List[str]) -> List[str]:  # noqa: N805
        clean = [c.strip() for c in v if c.strip()]
        if not clean:
            raise ValueError("commands list must contain at least one non-empty command")
        return clean


class SSHResponse(BaseModel):
    success: bool
    output: str
    error: str | None = None
    error_type: str | None = None
    executed_at: str
    device_name: str
    device_host: str


class CommandResponse(SSHResponse):
    command: str
    prompt: str = ""


class ConfigResponse(SSHResponse):
    commands_count: int


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _get_device_or_404(device_id: int, db: Session) -> models.Device:
    device = db.query(models.Device).filter(models.Device.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail=f"Device {device_id} not found.")
    return device


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/allowed-commands")
def get_allowed_commands() -> dict:
    """Return the list of commands available in the legacy Command Terminal dropdown."""
    # Return the canonical (user-friendly) set – strip duplicated abbreviations
    canonical = [
        "show ip interface brief",
        "show version",
        "show vlan brief",
        "show mac address-table",
        "show cdp neighbors",
        "show lldp neighbors",
    ]
    return {"commands": canonical}


@router.get("/blocked-patterns")
def get_blocked_patterns() -> dict:
    """
    Return the blacklist of destructive command patterns enforced by the
    real-CLI terminal. Used by the frontend to surface a quick reference
    of disallowed operations to the user.
    """
    return {"patterns": list(BLOCKED_TERMINAL_PATTERNS)}


@router.post("/terminal", response_model=CommandResponse)
def run_terminal_command(
    req: CommandRequest,
    db: Session = Depends(get_config_db),
) -> CommandResponse:
    """
    Execute a single operator-entered command on the specified device in
    "Real CLI" mode.

    Any command may be entered. Commands are validated against a
    destructive-operation blacklist (reload, erase, copy, configure
    terminal, clear, debug, etc.) before the SSH session is opened. All
    attempts — successful, failed, and blocked — are recorded in the
    audit log.
    """
    device = _get_device_or_404(req.device_id, db)

    result = execute_terminal_command(device=device, command=req.command, db=db)

    return CommandResponse(**result)


@router.post("/command", response_model=CommandResponse)
def run_command(
    req: CommandRequest,
    db: Session = Depends(get_config_db),
) -> CommandResponse:
    """
    Execute a single operational (show) command on the specified device.

    The command is validated against the allowed-list server-side.
    Device credentials are retrieved from the encrypted database.

    NOTE: retained for backwards compatibility. New frontend code should
    call ``POST /api/ssh/terminal`` instead, which supports arbitrary
    operational commands with blacklist-based validation.
    """
    device = _get_device_or_404(req.device_id, db)

    result = execute_show_command(device=device, command=req.command, db=db)

    if not result["success"]:
        # Return 200 with success=False so the frontend can render a
        # meaningful error message inside the terminal panel rather than
        # catching an HTTP exception.
        return CommandResponse(**result, prompt="")

    return CommandResponse(**result, prompt="")


@router.post("/config", response_model=ConfigResponse)
def push_config(
    req: ConfigRequest,
    db: Session = Depends(get_config_db),
) -> ConfigResponse:
    """
    Push a list of configuration commands to the specified device.

    Each command is validated for blocked / destructive patterns before
    the SSH session is opened.  All deployments are recorded in the
    audit log regardless of outcome.
    """
    device = _get_device_or_404(req.device_id, db)

    result = push_configuration(
        device=device,
        commands=req.commands,
        db=db,
        operator="admin",         # replace with session user once auth middleware is added
    )

    return ConfigResponse(**result)
