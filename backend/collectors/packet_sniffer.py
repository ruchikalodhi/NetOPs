import pyshark
import asyncio
import logging
from datetime import datetime
from typing import Optional, AsyncGenerator, Dict, Any

logger = logging.getLogger("packet_sniffer")
logging.basicConfig(level=logging.INFO)


class PacketSniffer:
    def __init__(
        self,
        interface: str = "eth0",
        bpf_filter: Optional[str] = None,
        display_filter: Optional[str] = None,
        include_raw: bool = False,
        max_packets: Optional[int] = None,
    ):
        self.interface = interface
        self.bpf_filter = bpf_filter
        self.display_filter = display_filter
        self.include_raw = include_raw
        self.max_packets = max_packets
        self.capture = None

    def _parse_packet(self, packet) -> Dict[str, Any]:
        data = {
            "timestamp": str(getattr(packet, "sniff_time", datetime.utcnow())),
            "length": int(getattr(packet, "length", 0)),
            "protocol": getattr(packet, "highest_layer", "UNKNOWN"),
        }

        try:
            if hasattr(packet, "ip"):
                data["src_ip"] = packet.ip.src
                data["dst_ip"] = packet.ip.dst
        except:
            pass

        try:
            if hasattr(packet, "tcp"):
                data["src_port"] = packet.tcp.srcport
                data["dst_port"] = packet.tcp.dstport
        except:
            pass

        try:
            if hasattr(packet, "udp"):
                data["src_port"] = packet.udp.srcport
                data["dst_port"] = packet.udp.dstport
        except:
            pass

        try:
            if hasattr(packet, "http"):
                data["http_host"] = getattr(packet.http, "host", None)
                data["http_method"] = getattr(packet.http, "request_method", None)
        except:
            pass

        if self.include_raw:
            data["raw"] = str(packet)

        return data

    async def start(self):
        self.capture = pyshark.LiveCapture(
            interface=self.interface,
            bpf_filter=self.bpf_filter,
            display_filter=self.display_filter,
        )
        return self.capture

    async def stream_packets(self) -> AsyncGenerator[Dict[str, Any], None]:
        if not self.capture:
            await self.start()

        count = 0

        for packet in self.capture.sniff_continuously():
            try:
                yield self._parse_packet(packet)
                count += 1

                if self.max_packets and count >= self.max_packets:
                    break

                await asyncio.sleep(0)

            except Exception as e:
                logger.error(f"Packet error: {e}")

    def stop(self):
        if self.capture:
            self.capture.close()