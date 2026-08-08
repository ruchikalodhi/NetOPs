"""
services/lldp_discovery.py
──────────────────────────
LLDP-based neighbor discovery via SNMP.

Queries the LLDP-MIB (1.0.8802.1.1.2) to collect neighboring device info.
Supports both SNMP v2c and v3 using the pysnmp library (same as trap receiver).

Neighbor output format (shared with CDP):
{
    "hostname":    str,
    "ip":          str,
    "platform":    str,
    "description": str,
    "local_port":  str,
    "remote_port": str,
    "chassis_id":  str,
    "protocol":    "LLDP",
    "device_type_hint": str   # classification hint
}
"""

import asyncio
import logging
from typing import List, Dict, Any

logger = logging.getLogger("lldp_discovery")

# ── LLDP MIB OID bases ──────────────────────────────────────────────────────
LLDP_MIB_BASE               = "1.0.8802.1.1.2"
LLDP_REM_CHASSIS_ID         = "1.0.8802.1.1.2.1.4.1.1.5"   # lldpRemChassisId
LLDP_REM_PORT_ID            = "1.0.8802.1.1.2.1.4.1.1.7"   # lldpRemPortId
LLDP_REM_PORT_DESC          = "1.0.8802.1.1.2.1.4.1.1.8"   # lldpRemPortDesc
LLDP_REM_SYS_NAME           = "1.0.8802.1.1.2.1.4.1.1.9"   # lldpRemSysName
LLDP_REM_SYS_DESC           = "1.0.8802.1.1.2.1.4.1.1.10"  # lldpRemSysDesc
LLDP_REM_MGMT_ADDR          = "1.0.8802.1.1.2.1.4.2.1.4"   # lldpRemManAddrIfSubtype (addr is in index)
LLDP_LOC_PORT_DESC          = "1.0.8802.1.1.2.1.3.7.1.4"   # lldpLocPortDesc (local port description)

# Local port ID table to resolve local interface names
LLDP_LOC_PORT_ID            = "1.0.8802.1.1.2.1.3.7.1.3"   # lldpLocPortId


def _snmp_walk(host: str, port: int, timeout: int, retries: int,
               version: str, community: str = "",
               sec_name: str = "", auth_proto: str = "", auth_key: str = "",
               priv_proto: str = "", priv_key: str = "",
               oid_base: str = "") -> List[tuple]:
    """
    Walk an OID subtree and return list of (oid_str, value_str) tuples.

    NOTE: pysnmp >=6.0 removed the old synchronous hlapi (SnmpEngine/nextCmd
    as a plain generator). The library is now asyncio-only, so we drive it
    via pysnmp.hlapi.v3arch.asyncio and wrap the coroutine with asyncio.run().
    This function is called from a background worker thread (see
    routers/discovery.py), so each call gets its own fresh event loop -
    do not call this from a thread that already has a running loop.
    """
    try:
        from pysnmp.hlapi.v3arch.asyncio import (
            SnmpEngine, CommunityData, UsmUserData,
            UdpTransportTarget, ContextData, ObjectType, ObjectIdentity,
            next_cmd, is_end_of_mib,
            usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
            usmHMAC256SHA384AuthProtocol, usmDESPrivProtocol, usmAesCfb128Protocol,
        )
    except ImportError as e:
        logger.error(f"[LLDP] pysnmp import failed - incompatible version installed "
                     f"(need pysnmp>=7.1,<8.0): {e}")
        return []

    async def _do_walk():
        results: List[tuple] = []

        if version.lower() == "v2c":
            auth = CommunityData(community, mpModel=1)
        else:
            _auth_map = {
                "MD5": usmHMACMD5AuthProtocol,
                "SHA": usmHMACSHAAuthProtocol,
                "SHA-256": usmHMAC256SHA384AuthProtocol,
            }
            _priv_map = {
                "DES": usmDESPrivProtocol,
                "AES": usmAesCfb128Protocol,
            }
            auth = UsmUserData(
                sec_name,
                authKey=auth_key,
                privKey=priv_key,
                authProtocol=_auth_map.get(auth_proto.upper(), usmHMACSHAAuthProtocol),
                privProtocol=_priv_map.get(priv_proto.upper(), usmAesCfb128Protocol),
            )

        engine = SnmpEngine()
        transport = await UdpTransportTarget.create((host, port), timeout=timeout, retries=retries)

        var_bind = ObjectType(ObjectIdentity(oid_base))
        max_rows = 500
        row_count = 0

        try:
            while row_count < max_rows:
                errorIndication, errorStatus, errorIndex, varBindTable = await next_cmd(
                    engine, auth, transport, ContextData(), var_bind, lookupMib=False,
                )
                if errorIndication:
                    logger.warning(f"[LLDP] SNMP walk error on {host}: {errorIndication}")
                    break
                if errorStatus:
                    logger.warning(
                        f"[LLDP] SNMP error status {errorStatus.prettyPrint()} at {errorIndex}"
                    )
                    break
                if not varBindTable or is_end_of_mib(varBindTable):
                    break

                oid_obj, value = varBindTable[0]
                oid_str = str(oid_obj)
                if not (oid_str == oid_base or oid_str.startswith(oid_base + ".")):
                    break  # walked past the end of the requested subtree

                results.append((oid_str, value.prettyPrint()))
                var_bind = ObjectType(ObjectIdentity(oid_str))
                row_count += 1
        finally:
            try:
                engine.transport_dispatcher.close_dispatcher()
            except Exception:
                pass

        return results

    try:
        return asyncio.run(_do_walk())
    except Exception as e:
        logger.warning(f"[LLDP] SNMP walk exception on {host}: {e}")
        return []


def _extract_index_suffix(oid_str: str, base_oid: str) -> str:
    """Return the index portion after the base OID."""
    if oid_str.startswith(base_oid + "."):
        return oid_str[len(base_oid) + 1:]
    return ""


def discover_lldp_neighbors(
    host: str,
    snmp_version: str,
    snmp_port: int,
    snmp_timeout: int,
    snmp_retries: int,
    community: str = "",
    snmp_username: str = "",
    auth_protocol: str = "",
    auth_password: str = "",
    priv_protocol: str = "",
    priv_password: str = "",
) -> List[Dict[str, Any]]:
    """
    Query LLDP MIB on the target device and return list of neighbor dicts.
    """
    logger.info(f"[LLDP] Starting discovery on {host}")

    def _walk(oid_base):
        return _snmp_walk(
            host=host, port=snmp_port, timeout=snmp_timeout, retries=snmp_retries,
            version=snmp_version, community=community,
            sec_name=snmp_username, auth_proto=auth_protocol, auth_key=auth_password,
            priv_proto=priv_protocol, priv_key=priv_password,
            oid_base=oid_base,
        )

    # Collect all relevant LLDP tables
    chassis_rows   = _walk(LLDP_REM_CHASSIS_ID)
    port_id_rows   = _walk(LLDP_REM_PORT_ID)
    port_desc_rows = _walk(LLDP_REM_PORT_DESC)
    sys_name_rows  = _walk(LLDP_REM_SYS_NAME)
    sys_desc_rows  = _walk(LLDP_REM_SYS_DESC)
    loc_port_rows  = _walk(LLDP_LOC_PORT_DESC)
    mgmt_rows      = _walk(LLDP_REM_MGMT_ADDR)

    if not chassis_rows and not sys_name_rows:
        logger.info(f"[LLDP] No LLDP neighbors found on {host}")
        return []

    # Build lookup maps keyed by index suffix (timeMark.localPortNum.remIdx)
    def _build_map(rows, base):
        m = {}
        for oid, val in rows:
            suffix = _extract_index_suffix(oid, base)
            if suffix:
                m[suffix] = val
        return m

    chassis_map   = _build_map(chassis_rows, LLDP_REM_CHASSIS_ID)
    port_id_map   = _build_map(port_id_rows, LLDP_REM_PORT_ID)
    port_desc_map = _build_map(port_desc_rows, LLDP_REM_PORT_DESC)
    sys_name_map  = _build_map(sys_name_rows, LLDP_REM_SYS_NAME)
    sys_desc_map  = _build_map(sys_desc_rows, LLDP_REM_SYS_DESC)

    # Build local port map keyed by port number
    loc_port_map = {}
    for oid, val in loc_port_rows:
        suffix = _extract_index_suffix(oid, LLDP_LOC_PORT_DESC)
        if suffix:
            # suffix is just the port number for local port table
            loc_port_map[suffix] = val

    # Build management IP map
    # LLDP mgmt addr index: timeMark.localPortNum.remIdx.addrSubtype.addrLen.addr...
    # We'll extract IPs from the OID index itself
    mgmt_ip_map = {}
    for oid, val in mgmt_rows:
        suffix = _extract_index_suffix(oid, LLDP_REM_MGMT_ADDR)
        if not suffix:
            continue
        parts = suffix.split(".")
        # parts[0]=timeMark, parts[1]=localPortNum, parts[2]=remIdx, parts[3]=addrSubtype, parts[4]=addrLen, parts[5:]=addr
        if len(parts) >= 9 and parts[3] == "1":  # subtype 1 = IPv4
            try:
                ip_parts = parts[5:9]
                ip = ".".join(ip_parts)
                # Key by timeMark.localPortNum.remIdx
                key = ".".join(parts[:3])
                mgmt_ip_map[key] = ip
            except Exception:
                pass

    # Use chassis_map keys as the set of neighbors
    all_keys = set(chassis_map.keys()) | set(sys_name_map.keys())

    neighbors = []
    seen_chassis = set()

    for key in all_keys:
        parts = key.split(".")
        if len(parts) < 3:
            continue
        local_port_num = parts[1] if len(parts) > 1 else ""

        chassis_id  = chassis_map.get(key, "")
        sys_name    = sys_name_map.get(key, "")
        sys_desc    = sys_desc_map.get(key, "")
        remote_port = port_desc_map.get(key, "") or port_id_map.get(key, "")
        local_port  = loc_port_map.get(local_port_num, f"Port {local_port_num}")

        # Deduplicate by chassis ID
        dedup_key = chassis_id or sys_name
        if dedup_key and dedup_key in seen_chassis:
            continue
        if dedup_key:
            seen_chassis.add(dedup_key)

        # Try to find management IP
        mgmt_key = ".".join(parts[:3])
        mgmt_ip = mgmt_ip_map.get(mgmt_key, "")

        # Classify device type from sysDescr
        device_type_hint = _classify_from_description(sys_desc, sys_name)

        neighbor = {
            "hostname":         sys_name or chassis_id or "Unknown",
            "ip":               mgmt_ip,
            "platform":         _extract_platform(sys_desc),
            "description":      sys_desc[:200] if sys_desc else "",
            "local_port":       local_port,
            "remote_port":      remote_port,
            "chassis_id":       chassis_id,
            "protocol":         "LLDP",
            "device_type_hint": device_type_hint,
        }
        neighbors.append(neighbor)

    logger.info(f"[LLDP] Found {len(neighbors)} neighbors on {host}")
    return neighbors


def _extract_platform(sys_desc: str) -> str:
    """Extract a short platform string from sysDescr."""
    if not sys_desc:
        return "Unknown"
    # Try to grab model from common Cisco patterns
    import re
    patterns = [
        r"(Cisco\s+\S+(?:\s+\S+)?)",
        r"(C\d{4}[A-Z-]*)",
        r"(WS-C\S+)",
        r"(AIR-\S+)",
    ]
    for pat in patterns:
        m = re.search(pat, sys_desc, re.IGNORECASE)
        if m:
            return m.group(1).strip()[:50]
    # Fall back to first 60 chars
    return sys_desc[:60]


def _classify_from_description(sys_desc: str, sys_name: str) -> str:
    """Classify device type from LLDP sysDescr and sysName."""
    text = (sys_desc + " " + sys_name).lower()

    if any(k in text for k in ["firewall", "asa", "ftd", "fortigate", "palo alto", "checkpoint"]):
        return "Firewall"
    if any(k in text for k in ["wireless controller", "wlc", "aireos", "catalyst 9800"]):
        return "Wireless Controller"
    if any(k in text for k in ["access point", "aironet", "air-", "ap1", "ap2"]):
        return "Access Point"
    if any(k in text for k in ["router", "isr", "asr", "7200", "7600", "agg"]):
        return "Router"
    if any(k in text for k in ["switch", "catalyst", "ws-c", "c9", "c3", "c2", "nexus"]):
        return "Switch"
    if any(k in text for k in ["server", "esxi", "vmware", "windows server", "linux"]):
        return "Server"

    return "Unknown"
