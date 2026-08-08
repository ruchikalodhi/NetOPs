"""
services/cdp_discovery.py
─────────────────────────
Cisco CDP (CISCO-CDP-MIB) neighbor discovery via SNMP.

Queries OID base: 1.3.6.1.4.1.9.9.23

Output format mirrors LLDP (protocol field = "CDP"):
{
    "hostname":    str,
    "ip":          str,
    "platform":    str,
    "description": str,
    "local_port":  str,
    "remote_port": str,
    "chassis_id":  str,
    "protocol":    "CDP",
    "device_type_hint": str
}
"""

import asyncio
import logging
from typing import List, Dict, Any

logger = logging.getLogger("cdp_discovery")

# ── CISCO-CDP-MIB OIDs ──────────────────────────────────────────────────────
CDP_CACHE_BASE          = "1.3.6.1.4.1.9.9.23.1.2.1.1"
CDP_CACHE_DEVICE_ID     = "1.3.6.1.4.1.9.9.23.1.2.1.1.6"   # cdpCacheDeviceId
CDP_CACHE_ADDRESS       = "1.3.6.1.4.1.9.9.23.1.2.1.1.4"   # cdpCacheAddress (IP)
CDP_CACHE_PLATFORM      = "1.3.6.1.4.1.9.9.23.1.2.1.1.8"   # cdpCachePlatform
CDP_CACHE_DEVICE_PORT   = "1.3.6.1.4.1.9.9.23.1.2.1.1.7"   # cdpCacheDevicePort (remote)
CDP_CACHE_VERSION       = "1.3.6.1.4.1.9.9.23.1.2.1.1.5"   # cdpCacheVersion (sysDescr)
CDP_CACHE_IF_INDEX      = "1.3.6.1.4.1.9.9.23.1.2.1.1.2"   # cdpCacheIfIndex -> local interface index

# ifDescr to resolve local interface name
IF_DESCR_BASE           = "1.3.6.1.2.1.2.2.1.2"            # ifDescr


def _build_auth(version: str, community: str, sec_name: str, auth_proto: str,
                 auth_key: str, priv_proto: str, priv_key: str,
                 CommunityData, UsmUserData,
                 usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
                 usmHMAC256SHA384AuthProtocol, usmDESPrivProtocol, usmAesCfb128Protocol):
    if version.lower() == "v2c":
        return CommunityData(community, mpModel=1)
    _auth_map = {
        "MD5": usmHMACMD5AuthProtocol,
        "SHA": usmHMACSHAAuthProtocol,
        "SHA-256": usmHMAC256SHA384AuthProtocol,
    }
    _priv_map = {
        "DES": usmDESPrivProtocol,
        "AES": usmAesCfb128Protocol,
    }
    return UsmUserData(
        sec_name,
        authKey=auth_key,
        privKey=priv_key,
        authProtocol=_auth_map.get(auth_proto.upper(), usmHMACSHAAuthProtocol),
        privProtocol=_priv_map.get(priv_proto.upper(), usmAesCfb128Protocol),
    )


def _snmp_walk(host: str, port: int, timeout: int, retries: int,
               version: str, community: str = "",
               sec_name: str = "", auth_proto: str = "", auth_key: str = "",
               priv_proto: str = "", priv_key: str = "",
               oid_base: str = "") -> List[tuple]:
    """
    Walk an OID subtree; return list of (oid_str, value_str).

    NOTE: pysnmp >=6.0 removed the old synchronous hlapi (SnmpEngine/nextCmd
    as a plain generator). The library is now asyncio-only, so we drive it
    via pysnmp.hlapi.v3arch.asyncio and wrap the coroutine with asyncio.run().
    Called from a background worker thread (see routers/discovery.py), so
    each call safely gets its own fresh event loop.
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
        logger.error(f"[CDP] pysnmp import failed - incompatible version installed "
                     f"(need pysnmp>=7.1,<8.0): {e}")
        return []

    async def _do_walk():
        results: List[tuple] = []
        auth = _build_auth(
            version, community, sec_name, auth_proto, auth_key, priv_proto, priv_key,
            CommunityData, UsmUserData, usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
            usmHMAC256SHA384AuthProtocol, usmDESPrivProtocol, usmAesCfb128Protocol,
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
                    logger.warning(f"[CDP] SNMP walk error on {host}: {errorIndication}")
                    break
                if errorStatus:
                    logger.warning(f"[CDP] SNMP error status: {errorStatus.prettyPrint()}")
                    break
                if not varBindTable or is_end_of_mib(varBindTable):
                    break

                oid_obj, value = varBindTable[0]
                oid_str = str(oid_obj)
                if not (oid_str == oid_base or oid_str.startswith(oid_base + ".")):
                    break

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
        logger.warning(f"[CDP] SNMP walk exception on {host}: {e}")
        return []


def _snmp_get(host: str, port: int, timeout: int, retries: int,
              version: str, community: str = "",
              sec_name: str = "", auth_proto: str = "", auth_key: str = "",
              priv_proto: str = "", priv_key: str = "",
              oid: str = "") -> str:
    """GET a single OID; returns value string or empty string."""
    try:
        from pysnmp.hlapi.v3arch.asyncio import (
            SnmpEngine, CommunityData, UsmUserData,
            UdpTransportTarget, ContextData, ObjectType, ObjectIdentity,
            get_cmd,
            usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
            usmHMAC256SHA384AuthProtocol, usmDESPrivProtocol, usmAesCfb128Protocol,
        )
    except ImportError as e:
        logger.error(f"[CDP] pysnmp import failed - incompatible version installed "
                     f"(need pysnmp>=7.1,<8.0): {e}")
        return ""

    async def _do_get():
        auth = _build_auth(
            version, community, sec_name, auth_proto, auth_key, priv_proto, priv_key,
            CommunityData, UsmUserData, usmHMACMD5AuthProtocol, usmHMACSHAAuthProtocol,
            usmHMAC256SHA384AuthProtocol, usmDESPrivProtocol, usmAesCfb128Protocol,
        )
        engine = SnmpEngine()
        transport = await UdpTransportTarget.create((host, port), timeout=timeout, retries=retries)
        try:
            errorIndication, errorStatus, errorIndex, varBinds = await get_cmd(
                engine, auth, transport, ContextData(), ObjectType(ObjectIdentity(oid)),
            )
        finally:
            try:
                engine.transport_dispatcher.close_dispatcher()
            except Exception:
                pass

        if errorIndication or errorStatus:
            return ""
        for vb in varBinds:
            return vb[1].prettyPrint()
        return ""

    try:
        return asyncio.run(_do_get())
    except Exception as e:
        logger.warning(f"[CDP] SNMP get exception on {host}: {e}")
        return ""


def _extract_suffix(oid_str: str, base_oid: str) -> str:
    if oid_str.startswith(base_oid + "."):
        return oid_str[len(base_oid) + 1:]
    return ""


def _parse_cdp_ip(hex_or_str: str) -> str:
    """
    CDP address is encoded as hex bytes in some MIB implementations.
    Try to parse it to a dotted-decimal IPv4.
    """
    import re
    # Already dotted-decimal?
    if re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", hex_or_str):
        return hex_or_str
    # Hex string like "0a0a0a02"
    if re.match(r"^[0-9a-fA-F]+$", hex_or_str) and len(hex_or_str) == 8:
        try:
            b = bytes.fromhex(hex_or_str)
            return ".".join(str(x) for x in b)
        except Exception:
            pass
    # pysnmp sometimes returns "0x0a0a0a02"
    if hex_or_str.startswith("0x"):
        raw = hex_or_str[2:]
        if len(raw) >= 8:
            try:
                b = bytes.fromhex(raw[-8:])
                return ".".join(str(x) for x in b)
            except Exception:
                pass
    return ""


def discover_cdp_neighbors(
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
    Query CISCO-CDP-MIB on the target device and return a list of neighbor dicts.
    Returns an empty list on non-Cisco devices or if CDP is disabled.
    """
    logger.info(f"[CDP] Starting discovery on {host}")

    kwargs = dict(
        host=host, port=snmp_port, timeout=snmp_timeout, retries=snmp_retries,
        version=snmp_version, community=community,
        sec_name=snmp_username, auth_proto=auth_protocol, auth_key=auth_password,
        priv_proto=priv_protocol, priv_key=priv_password,
    )

    def _walk(oid_base):
        return _snmp_walk(**kwargs, oid_base=oid_base)

    device_id_rows  = _walk(CDP_CACHE_DEVICE_ID)
    address_rows    = _walk(CDP_CACHE_ADDRESS)
    platform_rows   = _walk(CDP_CACHE_PLATFORM)
    dev_port_rows   = _walk(CDP_CACHE_DEVICE_PORT)
    version_rows    = _walk(CDP_CACHE_VERSION)
    if_idx_rows     = _walk(CDP_CACHE_IF_INDEX)

    if not device_id_rows:
        logger.info(f"[CDP] No CDP neighbors found on {host} (CDP may be disabled)")
        return []

    # Resolve ifIndex -> ifDescr for local interface names
    if_descr_rows = _walk(IF_DESCR_BASE)
    if_index_to_name: Dict[str, str] = {}
    for oid, val in if_descr_rows:
        suffix = _extract_suffix(oid, IF_DESCR_BASE)
        if suffix:
            if_index_to_name[suffix] = val

    def _build_map(rows, base):
        m = {}
        for oid, val in rows:
            suffix = _extract_suffix(oid, base)
            if suffix:
                m[suffix] = val
        return m

    device_id_map = _build_map(device_id_rows, CDP_CACHE_DEVICE_ID)
    address_map   = _build_map(address_rows, CDP_CACHE_ADDRESS)
    platform_map  = _build_map(platform_rows, CDP_CACHE_PLATFORM)
    dev_port_map  = _build_map(dev_port_rows, CDP_CACHE_DEVICE_PORT)
    version_map   = _build_map(version_rows, CDP_CACHE_VERSION)
    if_idx_map    = _build_map(if_idx_rows, CDP_CACHE_IF_INDEX)

    from services.lldp_discovery import _classify_from_description

    neighbors = []
    seen_device_ids = set()

    for key, device_id in device_id_map.items():
        if device_id in seen_device_ids:
            continue
        seen_device_ids.add(device_id)

        raw_ip      = address_map.get(key, "")
        mgmt_ip     = _parse_cdp_ip(raw_ip)
        platform    = platform_map.get(key, "Unknown")
        remote_port = dev_port_map.get(key, "")
        sys_desc    = version_map.get(key, "")
        if_idx      = if_idx_map.get(key, "")
        local_port  = if_index_to_name.get(if_idx, f"ifIndex {if_idx}" if if_idx else "")

        device_type_hint = _classify_from_description(sys_desc + " " + platform, device_id)

        neighbor = {
            "hostname":         device_id,
            "ip":               mgmt_ip,
            "platform":         platform[:100] if platform else "Unknown",
            "description":      sys_desc[:200] if sys_desc else "",
            "local_port":       local_port,
            "remote_port":      remote_port,
            "chassis_id":       device_id,
            "protocol":         "CDP",
            "device_type_hint": device_type_hint,
        }
        neighbors.append(neighbor)

    logger.info(f"[CDP] Found {len(neighbors)} neighbors on {host}")
    return neighbors
