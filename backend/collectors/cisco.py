"""
collectors/cisco.py
────────────────────
Cisco IOS / IOS-XE SSH collector.

Extended to support:
  - get_interfaces()   → interface operational/admin state + mode
  - get_environment()  → fan, PSU, temperature sensor health
"""

import re
import socket
import time
from netmiko import ConnectHandler
import ping3
from collectors.base import BaseCollector


class CiscoIOSCollector(BaseCollector):
    def __init__(
        self,
        host: str,
        username: str = "",
        password: str = "",
        secret: str = "",
        simulation_mode: bool = False,
    ):
        super().__init__(host, username, password, secret)

    # ─────────────────────────────────────────────
    # Connectivity
    # ─────────────────────────────────────────────

    def ping(self) -> dict:
        host = self.host
        sent = 3
        received = 0
        total_latency = 0.0

        for _ in range(sent):
            try:
                res = ping3.ping(host, timeout=1.0)
                if res is not None and res is not False:
                    received += 1
                    total_latency += res * 1000.0
            except Exception:
                pass
            time.sleep(0.05)

        packet_loss = ((sent - received) / sent) * 100.0
        avg_latency = (total_latency / received) if received > 0 else 0.0

        if received > 0:
            return {
                "reachable": True,
                "latency": round(avg_latency, 2),
                "packet_loss": round(packet_loss, 2),
                "state": "UP" if packet_loss < 50.0 else "DEGRADED",
            }

        if self._check_tcp_port(host, 22, timeout=1.5):
            return {"reachable": True, "latency": 25.0, "packet_loss": 100.0, "state": "DEGRADED"}

        return {"reachable": False, "latency": 0.0, "packet_loss": 100.0, "state": "DOWN"}

    # ─────────────────────────────────────────────
    # CPU / Memory
    # ─────────────────────────────────────────────

    def get_metrics(self) -> dict:
        device_params = self._base_params()
        try:
            net_connect = ConnectHandler(**device_params)
            net_connect.enable()
            cpu_output = net_connect.send_command("show processes cpu")
            mem_output = net_connect.send_command("show memory statistics")
            net_connect.disconnect()
            return {
                "cpu_utilization": self._parse_cisco_cpu(cpu_output),
                "memory_utilization": self._parse_cisco_mem(mem_output),
            }
        except Exception as e:
            print(f"[METRIC ERROR] SSH metrics failed for {self.host}: {e}")
            return {"cpu_utilization": 0.0, "memory_utilization": 0.0}

    # ─────────────────────────────────────────────
    # Interface status  (NEW)
    # ─────────────────────────────────────────────

    def get_interfaces(self) -> list[dict]:
        """
        Returns a list of interface dicts:
            name, description, admin_state, oper_state,
            mode, native_vlan, allowed_vlans, port_channel
        """
        device_params = self._base_params()
        interfaces = []
        try:
            nc = ConnectHandler(**device_params)
            nc.enable()

            # Basic status
            brief = nc.send_command("show interface status")
            # Trunk detail
            trunk_raw = nc.send_command("show interfaces trunk")
            # STP / err-disabled
            span_raw = nc.send_command("show spanning-tree summary")
            err_raw  = nc.send_command("show interfaces | include err-disabled")

            nc.disconnect()

            interfaces = self._parse_interface_status(brief)
            self._enrich_trunk_info(interfaces, trunk_raw)
            self._mark_err_disabled(interfaces, err_raw)

        except Exception as e:
            print(f"[IFACE ERROR] get_interfaces failed for {self.host}: {e}")

        return interfaces

    def _parse_interface_status(self, output: str) -> list[dict]:
        """Parse 'show interface status' output."""
        results = []
        for line in output.splitlines():
            # Skip header lines
            if not line.strip() or line.strip().startswith("Port") or line.strip().startswith("-"):
                continue
            parts = line.split()
            if len(parts) < 3:
                continue

            name = parts[0]
            # description may be absent – find status by last columns
            # Format: Port  Name  Status  Vlan  Duplex  Speed  Type
            try:
                status = parts[2].lower() if len(parts) > 2 else "unknown"
                vlan = parts[3] if len(parts) > 3 else ""

                admin_state = "Down" if "dis" in status else "Up"
                oper_state = "Up" if "connected" in status else ("Err-Disabled" if "err" in status else "Down")
                mode = "Access"
                if vlan.lower() == "trunk":
                    mode = "Trunk"
                elif "routed" in vlan.lower():
                    mode = "Routed"

                desc = " ".join(parts[1:2]) if len(parts) > 1 else ""

                results.append({
                    "name": name,
                    "description": desc,
                    "admin_state": admin_state,
                    "oper_state": oper_state,
                    "mode": mode,
                    "native_vlan": vlan if mode == "Access" else "",
                    "allowed_vlans": "",
                    "port_channel": "",
                })
            except Exception:
                continue
        return results

    def _enrich_trunk_info(self, interfaces: list[dict], trunk_output: str):
        """Add allowed VLAN info from 'show interfaces trunk'."""
        current_port = None
        section = None
        for line in trunk_output.splitlines():
            line = line.strip()
            if line.startswith("Port") and "Mode" in line:
                section = "mode"
                continue
            if line.startswith("Port") and "VLANs allowed on trunk" in line:
                section = "vlans"
                continue
            if line.startswith("Port") and "VLANs in spanning tree" in line:
                section = "stp"
                continue
            if section == "mode" and line and not line.startswith("-"):
                parts = line.split()
                if parts:
                    current_port = parts[0]
            if section == "vlans" and line and not line.startswith("-"):
                parts = line.split()
                if len(parts) >= 2:
                    port, vlans = parts[0], parts[1]
                    for iface in interfaces:
                        if iface["name"] == port:
                            iface["allowed_vlans"] = vlans
                            iface["mode"] = "Trunk"
                            break

    def _mark_err_disabled(self, interfaces: list[dict], err_output: str):
        """Flag err-disabled interfaces."""
        for line in err_output.splitlines():
            if "err-disabled" in line.lower():
                for iface in interfaces:
                    if iface["name"] in line:
                        iface["oper_state"] = "Err-Disabled"
                        break

    # ─────────────────────────────────────────────
    # Environmental health  (NEW)
    # ─────────────────────────────────────────────

    def get_environment(self) -> dict:
        """
        Returns environmental health data:
          fans: list of {name, status}
          psus: list of {name, status}
          temps: list of {name, value, threshold, status}
        """
        device_params = self._base_params()
        result = {"fans": [], "psus": [], "temps": []}
        try:
            nc = ConnectHandler(**device_params)
            nc.enable()
            env_output = nc.send_command("show environment all")
            nc.disconnect()
            result = self._parse_environment(env_output)
        except Exception as e:
            print(f"[ENV ERROR] get_environment failed for {self.host}: {e}")
        return result

    def _parse_environment(self, output: str) -> dict:
        fans, psus, temps = [], [], []
        section = None
        for line in output.splitlines():
            line_l = line.lower().strip()
            if "fan" in line_l and (":" in line or "status" in line_l):
                section = "fan"
            elif "power supply" in line_l or "psu" in line_l:
                section = "psu"
            elif "temperature" in line_l or "thermal" in line_l:
                section = "temp"

            if section == "fan" and line.strip():
                status = "OK" if ("ok" in line_l or "normal" in line_l or "present" in line_l) else "FAIL"
                fans.append({"name": line.strip()[:40], "status": status})

            elif section == "psu" and line.strip():
                status = "OK" if ("ok" in line_l or "normal" in line_l or "present" in line_l) else "FAIL"
                psus.append({"name": line.strip()[:40], "status": status})

            elif section == "temp":
                # Try to extract numeric temperature
                match = re.search(r"(\d+)\s*[Cc]", line)
                if match:
                    val = int(match.group(1))
                    status = "CRITICAL" if val > 75 else ("WARNING" if val > 65 else "OK")
                    temps.append({"name": line.strip()[:40], "value": val, "threshold": 75, "status": status})

        return {"fans": fans[:20], "psus": psus[:10], "temps": temps[:20]}

    # ─────────────────────────────────────────────
    # Config backup
    # ─────────────────────────────────────────────

    def backup_config(self) -> str:
        device_params = self._base_params()
        nc = ConnectHandler(**device_params)
        if self.secret:
            nc.enable()
        running_config = nc.send_command("show running-config")
        nc.disconnect()
        return running_config

    # ─────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────

    def _base_params(self) -> dict:
        return {
            "device_type": "cisco_ios",
            "host": self.host,
            "username": self.username,
            "password": self.password,
            "secret": self.secret,
            "timeout": 10,
        }

    def _check_tcp_port(self, host: str, port: int, timeout: float = 1.0) -> bool:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect((host, port))
                return True
        except Exception:
            return False

    def _parse_cisco_cpu(self, output: str) -> float:
        try:
            for line in output.splitlines():
                if "CPU utilization" in line:
                    parts = line.split("one minute:")
                    if len(parts) > 1:
                        return float(parts[1].split(";")[0].strip().replace("%", ""))
        except Exception:
            pass
        return 0.0

    def _parse_cisco_mem(self, output: str) -> float:
        try:
            for line in output.splitlines():
                if "Processor" in line or "System" in line:
                    parts = line.split()
                    if len(parts) >= 5:
                        total = float(parts[2])
                        used = float(parts[3])
                        if total > 0:
                            return round((used / total) * 100.0, 2)
        except Exception:
            pass
        return 0.0
