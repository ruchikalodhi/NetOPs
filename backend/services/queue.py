import threading
from typing import Set

class BackupQueueManager:
    """Manages active backup tasks to prevent parallel SSH executions on the same host."""
    _instance = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        with cls._lock:
            if not cls._instance:
                cls._instance = super(BackupQueueManager, cls).__new__(cls, *args, **kwargs)
                cls._instance.active_hosts = set()
                cls._instance.registry_lock = threading.Lock()
        return cls._instance

    def acquire_lock(self, host: str) -> bool:
        """
        Attempts to acquire a lock for a specific device host.
        Returns True if the lock was acquired, False if the host is already locked.
        """
        with self.registry_lock:
            if host in self.active_hosts:
                return False
            self.active_hosts.add(host)
            return True

    def release_lock(self, host: str):
        """Releases the lock for a specific device host."""
        with self.registry_lock:
            if host in self.active_hosts:
                self.active_hosts.remove(host)

    def is_locked(self, host: str) -> bool:
        """Checks if a host is currently undergoing backup."""
        with self.registry_lock:
            return host in self.active_hosts
