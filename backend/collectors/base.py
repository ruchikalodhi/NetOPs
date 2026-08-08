from abc import ABC, abstractmethod

class BaseCollector(ABC):
    def __init__(self, host: str, username: str = "", password: str = "", secret: str = ""):
        self.host = host
        self.username = username
        self.password = password
        self.secret = secret

    @abstractmethod
    def ping(self) -> dict:
        """
        Perform availability checks (ICMP ping or similar fast check).
        Returns:
            dict: {
                "reachable": bool,
                "latency": float (ms),
                "packet_loss": float (%)
            }
        """
        pass

    @abstractmethod
    def get_metrics(self) -> dict:
        """
        Poll performance metrics from the device (CPU, memory, etc.).
        Returns:
            dict: {
                "cpu_utilization": float (%),
                "memory_utilization": float (%)
            }
        """
        pass

    @abstractmethod
    def backup_config(self) -> str:
        """
        Establish configuration backup connection (SSH, REST, etc.) and fetch config.
        Returns:
            str: The running configuration content.
        Raises:
            Exception: If connection fails or retrieval fails.
        """
        pass
