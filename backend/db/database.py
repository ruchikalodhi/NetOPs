from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
from config import DATABASE_URL, METRICS_DATABASE_URL

# Connect arguments for SQLite to allow multi-threaded access (important for background worker threads)
connect_args = {}
if DATABASE_URL.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

# Engine and Sessions for config metadata and metrics (consolidated to single DB)
engine = create_engine(DATABASE_URL, connect_args=connect_args, poolclass=NullPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Backward compatibility aliases
config_engine = engine
metrics_engine = engine
ConfigSessionLocal = SessionLocal
MetricsSessionLocal = SessionLocal

Base = declarative_base()

# Helper functions to yield database sessions
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_config_db():
    db = ConfigSessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_metrics_db():
    db = MetricsSessionLocal()
    try:
        yield db
    finally:
        db.close()

