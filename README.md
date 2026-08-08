# NetOPs

**A modern Network Management System (NMS) & Network Performance Monitor (NPM)** for real-time visibility, control, and troubleshooting of enterprise network infrastructure.

NetOPs brings device auto-discovery, live topology mapping, remote configuration, packet-level diagnostics, and incident tracking together into a single full-stack platform — built for network and IT operations teams who need more than a static inventory spreadsheet.

---

## 1. Project Title & Description

**NetOPs** — an enterprise-grade Network Management System and Performance Monitor. It combines automated device discovery (LLDP/CDP/ICMP/SNMP), a live force-directed topology map, a browser-based SSH terminal, configuration backup and versioning, an SNMP trap receiver, packet capture and analysis, and structured incident management — all wrapped in a FastAPI backend and a React + TypeScript dashboard.

---

## 2. Overview

Most network teams juggle a patchwork of tools: one for pinging devices, another for pulling configs over SSH, a separate packet sniffer, and a spreadsheet for tracking incidents. NetOPs consolidates that workflow into one dashboard:

- **Discover** devices and their neighbors automatically over SNMP (LLDP/CDP).
- **Visualize** the live topology as an interactive graph.
- **Operate** on devices directly — run commands, push configuration, and pull backups — from an in-browser SSH terminal.
- **Monitor** health continuously via background polling (latency, packet loss, CPU, memory) and SNMP traps.
- **Diagnose** issues with a Wireshark-style packet capture and analysis workspace.
- **Track** problems end-to-end with a built-in incident management workflow, from detection through acknowledgement and resolution.

---

## 3. Key Features

### 🔍 Auto-Discovery
- Device discovery and health checks over **ICMP**
- Neighbor discovery via **LLDP** (LLDP-MIB) and **CDP** (CISCO-CDP-MIB) over **SNMP v2c/v3**
- One-click "discover neighbors" per device, with results importable directly into inventory

### 🗺️ Real-Time Network Topology
- Interactive, **force-directed topology graph** rendered natively in SVG
- Discovered LLDP/CDP links persisted and visualized with local/remote interface labels
- Live status coloring (UP / DEGRADED / DOWN / UNKNOWN) per node

### 💻 Interactive SSH Terminal & Configuration Push
- Browser-based SSH terminal backed by **Netmiko**, with an allow-listed command set and blocked-pattern filtering for safety
- One-off command execution and full configuration push endpoints
- Encrypted credential storage (AES-256 via `cryptography`) — device passwords and enable secrets are never stored in plaintext

### 🗄️ Configuration Backups
- On-demand and scheduled configuration backups per device
- Bulk "backup all" and ZIP export of the entire backup set
- Retry logic for flaky device connections

### 📡 SNMP Trap Receiver
- Background listener on UDP/162 for **SNMP v2c traps**
- Traps are parsed, de-duplicated (30-second suppression window), and converted into standardized **Incident** records with full audit logging

### 🧵 Packet Capture & Analysis
- Live packet capture over a WebSocket (`/ws/packets`), powered by **PyShark**
- Wireshark-style hex/ASCII inspection per packet
- BPF/display filtering support

### 🚨 Incident Management
- Centralized incident feed spanning connectivity, environmental, interface, hardware, power, and thermal events
- Acknowledge / resolve workflow with severity levels (critical, major, medium, minor, warning, low)
- Full audit trail of actions taken

### 📊 Metrics & Dashboard
- Continuous background polling of latency, packet loss, CPU, and memory utilization
- Regional/aggregate metrics endpoints for dashboard summaries
- Metrics ingestion endpoint for external telemetry sources

### 🔐 Auth & Settings
- Basic authentication (login/register) and application-level settings
- Full audit log of user and system actions

---

## 4. Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python, FastAPI, Uvicorn |
| **Frontend** | React 19, TypeScript, Vite |
| **Database** | SQLite (via SQLAlchemy ORM) |
| **Device Access** | Netmiko (SSH) |
| **Discovery / Monitoring** | pysnmp (SNMP v2c/v3), ping3 (ICMP) |
| **Packet Capture** | PyShark |
| **Charts** | Recharts |
| **Icons** | lucide-react |
| **Security** | `cryptography` (AES-256 credential encryption) |
| **Testing** | pytest |

---

## 5. System Architecture

```
┌─────────────────────────┐        REST / WebSocket        ┌──────────────────────────────┐
│   React + TypeScript    │ ◄─────────────────────────────► │           FastAPI             │
│   Dashboard (Vite)      │        http://localhost:8000    │   backend/main.py + routers    │
└─────────────────────────┘                                  └───────────────┬───────────────┘
                                                                              │
                             ┌────────────────────────────────────────────────┼────────────────────────────────┐
                             │                          │                     │                                 │
                     ┌───────▼───────┐         ┌────────▼────────┐   ┌────────▼────────┐              ┌─────────▼─────────┐
                     │  Discovery     │         │  SSH / Netmiko   │   │  Background       │              │  Packet Sniffer    │
                     │  (LLDP/CDP/    │         │  Terminal &      │   │  Workers           │              │  (PyShark, over    │
                     │  ICMP over     │         │  Config Push     │   │  (ping, metrics,   │              │  WebSocket)        │
                     │  SNMP)         │         │                  │   │  backups)          │              │                    │
                     └───────┬───────┘         └────────┬────────┘   └────────┬────────┘              └─────────┬─────────┘
                             │                           │                    │                                  │
                             └─────────────┬─────────────┴───────────┬────────┘                                  │
                                            │                         │                                          │
                                   ┌────────▼────────┐      ┌─────────▼─────────┐                                │
                                   │  SNMP Trap        │      │  SQLite            │◄──────────────────────────────┘
                                   │  Receiver (UDP    │      │  (devices,         │
                                   │  162) → Incidents │      │  metrics, backups, │
                                   └───────────────────┘      │  incidents, links, │
                                                               │  users, settings)  │
                                                               └────────────────────┘
```

**Flow summary:**
1. Devices are registered (or discovered) and stored with encrypted credentials.
2. Background workers continuously poll devices (ICMP + metrics) and update status/health.
3. LLDP/CDP discovery runs over SNMP to populate `DeviceLink` topology rows, rendered as an SVG graph on the frontend.
4. Operators can act on devices via the SSH terminal (guarded by allow/block command lists) or push configuration.
5. SNMP traps and health degradations are converted into `Incident` records, tracked through acknowledgement and resolution.
6. Packet capture streams live traffic to the frontend over a WebSocket for inline inspection.

---

## 6. Project Structure

```
NetOPs/
├── backend/
│   ├── main.py                  # FastAPI app: auth, devices, incidents, metrics, backups, packet WS
│   ├── config.py                # Env-driven configuration (DB, intervals, secret key)
│   ├── requirements.txt
│   ├── routers/
│   │   ├── ssh.py               # /api/ssh — terminal, command, config push
│   │   └── discovery.py         # /api/devices/{id}/discover, /api/topology
│   ├── services/
│   │   ├── ssh_service.py       # Netmiko SSH abstraction
│   │   ├── lldp_discovery.py    # LLDP-MIB neighbor discovery over SNMP
│   │   ├── cdp_discovery.py     # CISCO-CDP-MIB neighbor discovery over SNMP
│   │   ├── snmp_trap_receiver.py# UDP/162 trap listener → Incident records
│   │   ├── backup.py            # Device config backup execution
│   │   ├── worker.py            # Background polling workers (ping, metrics)
│   │   └── queue.py             # Backup queue manager
│   ├── collectors/
│   │   ├── base.py               # Base collector interface
│   │   ├── cisco.py              # Cisco-specific collection logic
│   │   └── packet_sniffer.py     # PyShark-based live capture
│   ├── db/
│   │   ├── database.py           # SQLAlchemy engine/session setup
│   │   ├── models.py             # Device, Metric, Incident, DeviceLink, Backup, User, Settings, AuditLog
│   │   └── security.py           # AES-256 credential encryption/decryption
│   ├── backups/                  # Stored device configuration backups
│   └── tests/                    # pytest test suite
├── frontend/
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   └── components/
│   │       ├── DashboardOverview.tsx
│   │       ├── DeviceList.tsx
│   │       ├── DeviceDetailModal.tsx
│   │       ├── DiscoveryModal.tsx
│   │       ├── NetworkTopology.tsx
│   │       ├── CommandTerminal.tsx
│   │       ├── ConfigurationPush.tsx
│   │       ├── BackupManager.tsx
│   │       ├── IncidentManagement.tsx
│   │       └── Settings.tsx
│   ├── package.json
│   └── vite.config.ts
├── .env.example
├── .gitignore
└── run.bat                       # Windows quick-start launcher
```

---

## 7. Screenshots / Demo
<img width="1919" height="901" alt="Screenshot 2026-06-30 153921" src="https://github.com/user-attachments/assets/500b7a28-4909-459c-992e-d2ec95896ef6" />

<img width="1919" height="902" alt="Screenshot 2026-06-30 153934" src="https://github.com/user-attachments/assets/9081fb99-fc37-4b33-ae13-a96a1176f6e6" />

<img width="1918" height="907" alt="Screenshot 2026-06-30 153952" src="https://github.com/user-attachments/assets/6285bd88-6f68-4aff-a120-8ed80b52fe46" />

<img width="1919" height="899" alt="Screenshot 2026-07-01 104346" src="https://github.com/user-attachments/assets/4ca8935d-8144-4f2d-90ad-14b8f63e3826" />

<img width="1919" height="912" alt="Screenshot 2026-07-01 112708" src="https://github.com/user-attachments/assets/8910fd0a-ee1a-44c0-b134-61715925d23b" />

<img width="1919" height="912" alt="Screenshot 2026-07-01 112622" src="https://github.com/user-attachments/assets/6a520bd2-4eba-4c59-816a-6e9c735ff71a" />

<img width="1919" height="634" alt="Screenshot 2026-07-01 112911" src="https://github.com/user-attachments/assets/b0ce4386-659e-4d07-9032-fce7afdcd440" />

<img width="1919" height="898" alt="Screenshot 2026-07-01 112757" src="https://github.com/user-attachments/assets/8ae06e7a-0642-4564-8ba6-d4e02b48ea1a" />



---

## 8. Installation & Setup

### Prerequisites
- Python 3.9+
- Node.js 16+
- npm
- Network access to target devices (SNMP read community + SSH credentials) for live discovery/monitoring features

### Clone the repository
```bash
git clone https://github.com/ruchikalodhi/NetOPs.git
cd NetOPs
```

### Backend setup
```bash
cd backend
python -m venv venv
source venv/bin/activate      # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### Frontend setup
```bash
cd frontend
npm install
```

### Environment configuration
```bash
cp .env.example .env
```
Then edit `.env` and set at minimum a strong `SECRET_KEY` (see [Configuration](#12-configuration) below).

---

## 9. Running the Application

### Option A — Quick start (Windows)
From the project root:
```bash
run.bat
```
This launches both the backend and frontend in separate windows.

### Option B — Manual start

**Backend:**
```bash
cd backend
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

**Frontend:**
```bash
cd frontend
npm run dev
```

Once both are running:
- **Frontend dashboard:** `http://localhost:5173`
- **Backend API:** `http://localhost:8000`
- **Health check:** `http://localhost:8000/api/health`

---

## 10. Core Workflow

1. **Register a device** — add hostname/IP, device type, and SSH credentials (encrypted at rest).
2. **Run discovery** — trigger LLDP/CDP discovery on a device to find its neighbors over SNMP.
3. **Import discovered neighbors** — bring newly found devices into inventory with one action.
4. **View topology** — the discovered links render automatically as an interactive force-directed graph.
5. **Monitor health** — background workers continuously ping devices and collect latency/packet-loss/CPU/memory metrics.
6. **Operate** — open the in-browser SSH terminal to run commands or push configuration changes; back up configs on demand or on a schedule.
7. **Respond to incidents** — SNMP traps and health degradations surface as incidents; acknowledge and resolve them from the Incident Management view.
8. **Investigate traffic** — start a live packet capture for deep packet inspection when troubleshooting connectivity issues.

---

## 11. API Documentation

FastAPI auto-generates interactive API docs once the backend is running:
- **Swagger UI:** `http://localhost:8000/docs`
- **ReDoc:** `http://localhost:8000/redoc`

### Selected endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Authenticate a user |
| `POST` | `/api/auth/register` | Register a new user |
| `GET` | `/api/devices` | List all devices |
| `POST` | `/api/devices` | Register a new device |
| `PUT` | `/api/devices/{device_id}` | Update a device |
| `DELETE` | `/api/devices/{device_id}` | Remove a device |
| `POST` | `/api/devices/{device_id}/test-connection` | Verify SSH/SNMP reachability |
| `GET` | `/api/devices/{host}/metrics` | Get metrics history for a device |
| `POST` | `/api/devices/{device_id}/discover` | Trigger LLDP/CDP neighbor discovery |
| `GET` | `/api/devices/{device_id}/discover/status/{task_id}` | Poll discovery task status |
| `POST` | `/api/devices/import-discovered` | Import discovered neighbors into inventory |
| `GET` | `/api/topology` | Fetch current network topology graph |
| `POST` | `/api/ssh/terminal` | Execute an interactive terminal command |
| `POST` | `/api/ssh/command` | Execute a single command |
| `POST` | `/api/ssh/config` | Push configuration changes |
| `GET` | `/api/ssh/allowed-commands` | List permitted commands |
| `GET` | `/api/ssh/blocked-patterns` | List blocked command patterns |
| `POST` | `/api/devices/{host}/backup` | Back up a single device's configuration |
| `POST` | `/api/backup/all` | Back up all devices |
| `GET` | `/api/backups` | List stored backups |
| `GET` | `/api/backups/download/{backup_id}` | Download a single backup |
| `GET` | `/api/backups/download-zip` | Download all backups as a ZIP |
| `GET` | `/api/incidents` | List incidents |
| `PUT` | `/api/incidents/{incident_id}/acknowledge` | Acknowledge an incident |
| `PUT` | `/api/incidents/{incident_id}/resolve` | Resolve an incident |
| `GET` | `/api/metrics/regions` | Aggregate regional metrics |
| `POST` | `/api/metrics/ingest` | Ingest external telemetry |
| `GET` | `/api/audit-logs` | View audit log history |
| `GET` | `/api/stats` | Dashboard summary statistics |
| `GET` / `PUT` | `/api/settings` | Get/update application settings |
| `GET` | `/api/health` | Service health check |
| `WS` | `/ws/packets` | Live packet capture stream |

---

## 12. Configuration

Configuration is managed via environment variables (`backend/.env`, based on `.env.example`):

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | SQLAlchemy database URL | `sqlite:///./network_monitor.db` |
| `METRICS_DATABASE_URL` | Metrics database URL | `sqlite:///./metrics.db` |
| `BACKUP_PATH` | Directory for stored config backups | `backups` |
| `PING_INTERVAL` | Seconds between ICMP health checks | `15` |
| `METRICS_INTERVAL` | Seconds between metrics collection cycles | `300` |
| `BACKUP_INTERVAL` | Seconds between scheduled backup cycles | `300` |
| `SECRET_KEY` | 32+ byte random secret used to derive the AES-256 key for encrypting stored device credentials — generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"` | _must be set_ |
| `ENVIRONMENT` | Runtime environment name (`demo`, `production`, etc.) | `demo` |
| `SEED_DEVICE_USERNAME` / `SEED_DEVICE_PASSWORD` | Optional — used only when bootstrapping a brand-new empty database with a default device list | unset |

> ⚠️ Never commit a real `.env` file. `SECRET_KEY` must be changed from the default before any non-local use — the backend prints a security warning at startup if it isn't.

---

## 13. Testing

The backend includes a `pytest`-based test suite:

```bash
cd backend
pytest
```

---

## 14. Troubleshooting

| Issue | Likely Cause / Fix |
|---|---|
| Backend prints a `[SECURITY WARNING]` about `SECRET_KEY` | `.env` wasn't created or `SECRET_KEY` was left at its default — copy `.env.example` to `.env` and set a real secret |
| Frontend can't reach the API | Confirm the backend is running on port `8000` and that the frontend origin is included in `CORSMiddleware.allow_origins` in `main.py` |
| Device shows `UNKNOWN`/`DOWN` status | Verify ICMP reachability and that SSH/SNMP credentials for the device are correct via `POST /api/devices/{device_id}/test-connection` |
| LLDP/CDP discovery returns no neighbors | Confirm the device's SNMP community string/credentials are correct and that LLDP/CDP is enabled on the device itself |
| SNMP traps aren't creating incidents | Ensure UDP/162 is reachable from the sending device to the backend host and not blocked by a firewall |
| Packet capture WebSocket doesn't connect | Confirm the backend process has permission to open a live capture interface (may require elevated privileges depending on OS) |
| SSH commands rejected | Check `/api/ssh/allowed-commands` and `/api/ssh/blocked-patterns` — commands are filtered by design for safety |

---

## 15. Roadmap

- [ ] Role-based access control (RBAC)
- [ ] Multi-vendor device profile expansion (beyond Cisco IOS)
- [ ] Historical performance graphing improvements (bandwidth, jitter, long-range trends)
- [ ] Alerting integrations (email/Slack/webhook) triggered from incidents
- [ ] Containerized deployment (Docker Compose)
- [ ] SNMP v3 coverage parity across all discovery paths
- [ ] Expanded automated test coverage

---

## 16. Known Limitations

- Discovery and MIB parsing are currently tuned primarily for **Cisco** devices (CISCO-CDP-MIB, standard LLDP-MIB); other vendors may need adapter work.
- SQLite is well-suited for demos/small deployments but is not intended for high-concurrency production workloads — a Postgres migration path is a natural next step.
- Packet capture depends on **PyShark**, which requires a working `tshark`/Wireshark installation on the host machine.
- The SSH terminal allow/block-list is a safety net, not a full command sandbox — review the list before exposing this to untrusted users.
- The bundled `run.bat` launcher is Windows-only; Linux/macOS users should start the backend and frontend manually (see [Running the Application](#9-running-the-application)).
- Automated test coverage is currently minimal (`backend/tests/` scaffold present but not fully built out).

---

## 17. Future Improvements

- Docker Compose setup for one-command deployment across platforms
- Pluggable vendor discovery adapters (Juniper, Arista, etc.)
- WebSocket-based live topology updates (rather than poll/refresh)
- Notification channels for incidents (email, Slack, webhooks)
- User roles and granular permissions
- Postgres/MySQL support alongside SQLite
- Richer historical analytics and capacity-planning views

---

## 18. Contributors

**Ruchika Lodhi**
GitHub: [@ruchikalodhi](https://github.com/ruchikalodhi)

Contributions are welcome — feel free to open an [issue](https://github.com/ruchikalodhi/NetOPs/issues) or submit a pull request.

---
