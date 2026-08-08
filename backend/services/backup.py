import gzip
import hashlib
import os
import time
import re
import socket
from datetime import datetime
from typing import Tuple, Optional
from sqlalchemy.orm import Session
from config import BACKUP_PATH
import config
from db.database import ConfigSessionLocal
from db.models import Backup, Device, AuditLog
from db.security import decrypt_value
from collectors.cisco import CiscoIOSCollector
from services.queue import BackupQueueManager
from netmiko.exceptions import NetmikoTimeoutException, NetmikoAuthenticationException

def sanitize_error_message(msg: str) -> str:
    """Masks sensitive credentials in error messages."""
    if not msg:
        return ""
    # Mask password or secret
    msg = re.sub(r"(['\"]password['\"]:\s*['\"])[^'\"]+(['\"])", r"\1*****\2", msg)
    msg = re.sub(r"(['\"]secret['\"]:\s*['\"])[^'\"]+(['\"])", r"\1*****\2", msg)
    msg = re.sub(r"(password|secret)\s*=\s*[^\s,]+", r"\1=*****", msg)
    return msg

def validate_configuration(config_text: str) -> Tuple[bool, Optional[str]]:
    """
    Validates the running configuration retrieved from the network device.
    """
    if not config_text or not config_text.strip():
        return False, "Configuration is empty"

    # Verify configuration length > 100 characters
    if len(config_text) <= 100:
        return False, "Configuration too short (must be > 100 characters)"

    # Configuration must contain 'hostname'
    if "hostname" not in config_text:
        return False, "Configuration does not contain expected hostname parameter"

    # Configuration must contain multiple lines
    if "\n" not in config_text and "\r" not in config_text:
        return False, "Configuration is single line"

    # Configuration is not a known simulation template or hardcoded demo content
    reject_patterns = [
        "15:42:10 UTC Fri Jun 5 2026 by admin",
        "Cisco IOS Running Configuration - Switch V1.0",
        "Cisco IOS Running Configuration - Switch V1.1",
        "SHOW IP INTERFACE BRIEF OUTPUT:",
        "! BACKUP FOR DEVICE:",
        "Cisco_L2_Switch"
    ]
    for pattern in reject_patterns:
        if pattern in config_text:
            return False, "Rejected simulated configuration or placeholder content"

    return True, None

def execute_device_backup(host: str, triggered_by: str = "system", source_ip: str = "127.0.0.1") -> dict:
    """
    Runs configuration backup for a single device, checks for configuration modifications,
    compresses output with gzip, and logs success/failure metrics + audit trail.
    """
    queue_mgr = BackupQueueManager()
    
    # Try to acquire lock to prevent concurrent runs on the same device
    if not queue_mgr.acquire_lock(host):
        return {
            "status": "RUNNING",
            "message": f"Backup for {host} is already in progress.",
            "timestamp": datetime.utcnow()
        }

    db = ConfigSessionLocal()
    start_time = datetime.utcnow()
    start_t = time.time()
    
    device_name = ""
    device_type = "cisco_ios"
    
    try:
        # 1. Fetch Device from DB
        device = db.query(Device).filter(Device.host == host).first()
        if not device:
            queue_mgr.release_lock(host)
            return {
                "status": "FAILED",
                "message": f"Device {host} not found in database.",
                "timestamp": datetime.utcnow()
            }

        device_name = device.name
        device_type = device.device_type

        # PHASE 2: DEVICE REACHABILITY VERIFICATION
        username = device.username
        password = decrypt_value(device.password_encrypted)
        secret = decrypt_value(device.secret_encrypted)

        # Force real communication
        collector = CiscoIOSCollector(host, username, password, secret, simulation_mode=False)
        
        ping_res = collector.ping()
        if not ping_res["reachable"]:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "Device unreachable"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="UNREACHABLE",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: {err_msg}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "UNREACHABLE",
                "message": err_msg,
                "timestamp": end_time
            }

        # PHASE 3: SSH AUTHENTICATION VALIDATION & PHASE 4: REAL CONFIGURATION COLLECTION
        try:
            config_text = collector.backup_config()
        except NetmikoAuthenticationException as auth_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "Authentication failed"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="AUTH_FAILED",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: SSH authentication failed on device {device_name}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "AUTH_FAILED",
                "message": err_msg,
                "timestamp": end_time
            }
        except NetmikoTimeoutException as timeout_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "SSH timeout"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="TIMEOUT",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: SSH timeout on device {device_name}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "TIMEOUT",
                "message": err_msg,
                "timestamp": end_time
            }
        except ValueError as val_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "Enable secret invalid" if "enable" in str(val_err).lower() else "Command execution failures"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="FAILED",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=sanitize_error_message(f"Backup failed: {str(val_err)}"),
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "FAILED",
                "message": err_msg,
                "timestamp": end_time
            }
        except socket.gaierror as dns_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "Host resolution failed"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="FAILED",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: Host resolution failed for {host}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "FAILED",
                "message": err_msg,
                "timestamp": end_time
            }
        except (socket.error, ConnectionRefusedError) as sock_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            err_msg = "Connection refused"
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="FAILED",
                error_message=err_msg,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: SSH connection refused on {host}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "FAILED",
                "message": err_msg,
                "timestamp": end_time
            }
        except Exception as generic_err:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            sanitized_err = sanitize_error_message(str(generic_err))
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="FAILED",
                error_message=sanitized_err,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup failed: {sanitized_err}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "FAILED",
                "message": sanitized_err,
                "timestamp": end_time
            }

        # PHASE 5: CONFIGURATION VALIDATION
        is_valid, validation_reason = validate_configuration(config_text)
        if not is_valid:
            end_time = datetime.utcnow()
            elapsed = round(time.time() - start_t, 2)
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="VALIDATION_FAILED",
                error_message=validation_reason,
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup configuration validation failed: {validation_reason}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "VALIDATION_FAILED",
                "message": validation_reason,
                "timestamp": end_time
            }

        # PHASE 6: HASHING AND FILE STORAGE
        end_time = datetime.utcnow()
        elapsed = round(time.time() - start_t, 2)
        config_hash = hashlib.sha256(config_text.encode("utf-8")).hexdigest()

        # Check last successful backup to see if configuration changed
        last_backup = db.query(Backup).filter(
            Backup.device_host == host,
            Backup.status == "SUCCESS"
        ).order_by(Backup.timestamp.desc()).first()

        if last_backup and last_backup.config_hash == config_hash:
            # Unchanged! Reuse reference
            new_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name=last_backup.file_name,
                file_path=last_backup.file_path,
                config_hash=config_hash,
                status="SUCCESS",
                error_message="Configuration unchanged. Database reference updated.",
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(new_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup completed. Configuration unchanged. Hash: {config_hash[:10]}...",
                level="INFO"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "SUCCESS",
                "message": "Configuration unchanged. Reference updated.",
                "file_name": last_backup.file_name,
                "timestamp": end_time
            }

        # Save new file using device name as safe hostname prefix
        timestamp_str = end_time.strftime("%Y%m%d_%H%M%S")
        safe_hostname = device_name.replace(" ", "_").replace("/", "_")
        file_name = f"{safe_hostname}_running_config_{timestamp_str}.txt.gz"
        file_path = os.path.join(BACKUP_PATH, file_name)

        # Write compressed file
        with gzip.open(file_path, "wt", encoding="utf-8") as f:
            f.write(config_text)

        # PHASE 7: BACKUP FILE INTEGRITY VERIFICATION
        try:
            with gzip.open(file_path, "rt", encoding="utf-8") as f:
                saved_content = f.read()
            
            if saved_content != config_text:
                raise ValueError("Integrity mismatch: file contents differ from collected config.")
        except Exception as verify_err:
            # Delete corrupted file
            if os.path.exists(file_path):
                os.remove(file_path)
            
            failed_backup = Backup(
                device_host=host,
                device_name=device_name,
                device_type=device_type,
                start_time=start_time,
                end_time=end_time,
                timestamp=end_time,
                file_name="",
                file_path="",
                config_hash="",
                status="FAILED",
                error_message="Backup file verification failed",
                execution_time=elapsed,
                triggered_by=triggered_by
            )
            db.add(failed_backup)
            
            audit = AuditLog(
                timestamp=end_time,
                username=triggered_by,
                action="BACKUP_DEVICE_FAILED",
                device_host=host,
                source_ip=source_ip,
                details=f"Backup verification failed: {str(verify_err)}",
                level="ERROR"
            )
            db.add(audit)
            db.commit()
            
            return {
                "status": "FAILED",
                "message": "Backup file verification failed",
                "timestamp": end_time
            }

        # SUCCESS
        new_backup = Backup(
            device_host=host,
            device_name=device_name,
            device_type=device_type,
            start_time=start_time,
            end_time=end_time,
            timestamp=end_time,
            file_name=file_name,
            file_path=file_path,
            config_hash=config_hash,
            status="SUCCESS",
            execution_time=elapsed,
            triggered_by=triggered_by
        )
        db.add(new_backup)

        audit = AuditLog(
            timestamp=end_time,
            username=triggered_by,
            action="BACKUP_DEVICE",
            device_host=host,
            source_ip=source_ip,
            details=f"Backup completed. File created: {file_name}. Hash: {config_hash[:10]}...",
            level="INFO"
        )
        db.add(audit)
        db.commit()
        
        return {
            "status": "SUCCESS",
            "message": f"Backup completed. File created: {file_name}",
            "file_name": file_name,
            "timestamp": end_time
        }

    except Exception as outer_err:
        end_time = datetime.utcnow()
        elapsed = round(time.time() - start_t, 2)
        sanitized_err = sanitize_error_message(str(outer_err))
        
        failed_backup = Backup(
            device_host=host,
            device_name=device_name,
            device_type=device_type,
            start_time=start_time,
            end_time=end_time,
            timestamp=end_time,
            file_name="",
            file_path="",
            config_hash="",
            status="FAILED",
            error_message=sanitized_err,
            execution_time=elapsed,
            triggered_by=triggered_by
        )
        db.add(failed_backup)
        
        audit = AuditLog(
            timestamp=end_time,
            username=triggered_by,
            action="BACKUP_DEVICE_FAILED",
            device_host=host,
            source_ip=source_ip,
            details=f"Crash recovery backup failure: {sanitized_err}",
            level="ERROR"
        )
        db.add(audit)
        db.commit()
        
        return {
            "status": "FAILED",
            "message": sanitized_err,
            "timestamp": end_time
        }

    finally:
        db.close()
        queue_mgr.release_lock(host)
