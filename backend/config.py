import os
from pathlib import Path
from dotenv import load_dotenv

# Search for .env in current directory or parent directory
env_path = Path(__file__).resolve().parent.parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./network_monitor.db")
METRICS_DATABASE_URL = DATABASE_URL
BACKUP_PATH = str((Path(__file__).resolve().parent / Path(os.getenv("BACKUP_PATH", "backups"))).resolve())
PING_INTERVAL = int(os.getenv("PING_INTERVAL", "15"))
METRICS_INTERVAL = int(os.getenv("METRICS_INTERVAL", "300"))
BACKUP_INTERVAL = int(os.getenv("BACKUP_INTERVAL", "300"))
SECRET_KEY = os.getenv("SECRET_KEY", "CHANGE_ME_TO_A_RANDOM_SECRET")
if SECRET_KEY == "CHANGE_ME_TO_A_RANDOM_SECRET":
    print("[SECURITY WARNING] SECRET_KEY is not set. Using an insecure default. "
          "Set SECRET_KEY in your .env file (see .env.example).")

ENVIRONMENT = os.getenv("ENVIRONMENT", "demo").lower()
CONNECTION_TIMEOUT = 10
MAX_BACKUP_RETRIES = 2


# Ensure backup path exists
os.makedirs(BACKUP_PATH, exist_ok=True)
