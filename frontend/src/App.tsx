import { useState, useEffect } from 'react';
import {
  Activity,
  Server,
  RefreshCw,
  Settings as SettingsIcon,
  Wifi,
  Database,
  AlertTriangle,
  Terminal,
  Upload,
  GitBranch,
} from 'lucide-react';
import { DashboardOverview } from './components/DashboardOverview';
import { DeviceList } from './components/DeviceList';
import { IncidentManagement } from './components/IncidentManagement';
import { BackupManager } from './components/BackupManager';
import { Settings } from './components/Settings';
import { DeviceDetailModal } from './components/DeviceDetailModal';
import { CommandTerminal } from './components/CommandTerminal';
import { ConfigurationPush } from './components/ConfigurationPush';
import { NetworkTopology } from './components/NetworkTopology';

// ─── Types ─────────────────────────────────────────────────────────────────────

type TabKey =
  | 'dashboard'
  | 'inventory'
  | 'incidents'
  | 'backups'
  | 'terminal'
  | 'pushconfig'
  | 'topology'
  | 'settings';

// ─── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('dashboard');
  const [devices, setDevices]     = useState<any[]>([]);
  const [stats, setStats]         = useState<any>(null);
  const [selectedDevice, setSelectedDevice] = useState<any>(null);
  const [lastUpdated, setLastUpdated]       = useState<string>('');
  const [refreshing, setRefreshing]         = useState(false);
  const [tickets, setTickets]               = useState<any[]>([]);

  const fetchData = async () => {
    try {
      setRefreshing(true);

      const devRes = await fetch('http://localhost:8000/api/devices');
      if (devRes.ok) setDevices(await devRes.json());

      const ticketRes = await fetch('http://localhost:8000/api/incidents');
      if (ticketRes.ok) {
        const data = await ticketRes.json();
        setTickets(data.map((t: any) => ({ ...t, host: t.device_host })));
      }

      const statsRes = await fetch('http://localhost:8000/api/stats');
      if (statsRes.ok) setStats(await statsRes.json());

      setLastUpdated(new Date().toLocaleTimeString());
    } catch (e) {
      console.error('Failed to fetch dashboard data:', e);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleAcknowledgeTicket = async (id: string) => {
    const res = await fetch(`http://localhost:8000/api/incidents/${id}/acknowledge`, { method: 'PUT' });
    if (res.ok) fetchData();
    else alert('Failed to acknowledge ticket.');
  };

  const handleResolveTicket = async (id: string) => {
    const res = await fetch(`http://localhost:8000/api/incidents/${id}/resolve`, { method: 'PUT' });
    if (res.ok) fetchData();
    else alert('Failed to resolve ticket.');
  };

  const handleTriggerBackup = async (host: string) => {
    const res = await fetch(`http://localhost:8000/api/devices/${host}/backup`, { method: 'POST' });
    if (res.ok) setDevices(prev => prev.map(d => d.host === host ? { ...d, is_locked: true } : d));
    else alert(`Failed to queue backup for ${host}`);
  };

  const handleTriggerBackupAll = async () => {
    const res = await fetch('http://localhost:8000/api/backup/all', { method: 'POST' });
    if (res.ok) fetchData();
    else alert('Failed to trigger bulk backup.');
  };

  const handleDeleteDevice = async (id: number) => {
    const res = await fetch(`http://localhost:8000/api/devices/${id}`, { method: 'DELETE' });
    if (res.ok) fetchData();
    else alert('Failed to delete device.');
  };

  const handleAddDevice = async (deviceData: any): Promise<boolean> => {
    try {
      const res = await fetch('http://localhost:8000/api/devices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deviceData),
      });
      if (res.ok) { fetchData(); return true; }
      return false;
    } catch {
      return false;
    }
  };

  const isAnyBackupRunning = devices.some(d => d.is_locked);

  // ── Navigation config ────────────────────────────────────────────────────

  const TAB_LABELS: Record<TabKey, string> = {
    dashboard:  'Network Telemetry Overview',
    inventory:  'Device Inventory',
    incidents:  'Active Incident Tickets (RTO & Outages)',
    backups:    'Backup Operations Hub',
    terminal:   'SSH Command Terminal',
    pushconfig: 'Push Configuration',
    topology:   'Network Topology',
    settings:   'System Configuration Settings',
  };

  const navItems: { key: TabKey; label: string; Icon: React.ElementType }[] = [
    { key: 'dashboard',  label: 'Dashboard',         Icon: Activity       },
    { key: 'inventory',  label: 'Device Inventory',  Icon: Server         },
    { key: 'incidents',  label: 'Active Incidents',  Icon: AlertTriangle  },
    { key: 'backups',    label: 'Config Backups',    Icon: Database       },
    { key: 'terminal',   label: 'Command Terminal',  Icon: Terminal       },
    { key: 'pushconfig', label: 'Push Configuration',Icon: Upload         },
    { key: 'topology',   label: 'Network Topology',  Icon: GitBranch      },
    { key: 'settings',   label: 'System Settings',   Icon: SettingsIcon   },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="app-container">
      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="logo-container">
          <Wifi size={28} color="var(--primary)" style={{ filter: 'drop-shadow(0 0 8px var(--primary))' }} />
          <div>
            <div className="logo-text">NetOps</div>
            <div className="logo-subtext">Dashboard v1.0</div>
          </div>
        </div>

        <nav className="nav-list">
          {navItems.map(({ key, label, Icon }) => (
            <div
              key={key}
              className={`nav-item ${activeTab === key ? 'active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </div>
          ))}
        </nav>

        <div className="sidebar-footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Profile: <span style={{ color: 'var(--primary)', fontWeight: 700 }}>NOC OPERATOR</span>
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            Devices: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>36 Cisco Switches</span>
          </div>
        </div>
      </aside>

      {/* ── Main workspace ────────────────────────────────────────────── */}
      <main className="main-workspace">
        <header className="header">
          <div className="header-title">
            <h1 style={{ textTransform: 'none' }}>{TAB_LABELS[activeTab]}</h1>
            {activeTab === 'backups' && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Manage and run backups for Cisco devices
              </p>
            )}
            {activeTab === 'terminal' && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Execute operational commands on managed devices over SSH
              </p>
            )}
            {activeTab === 'pushconfig' && (
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                Deploy configuration changes directly to managed devices
              </p>
            )}
          </div>
          <div className="header-actions">
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Last Updated:{' '}
              <span className="mono" style={{ color: 'var(--text-primary)' }}>{lastUpdated || 'Loading...'}</span>
            </span>
            <button className="btn btn-secondary" onClick={fetchData} disabled={refreshing} style={{ padding: '8px' }}>
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            </button>
          </div>
        </header>

        <div className="page-viewport">
          {activeTab === 'dashboard' && (
            <DashboardOverview
              stats={stats}
              devices={devices}
              tickets={tickets}
              onAcknowledgeTicket={handleAcknowledgeTicket}
              onResolveTicket={handleResolveTicket}
            />
          )}
          {activeTab === 'inventory' && (
            <DeviceList
              devices={devices}
              onTriggerBackup={handleTriggerBackup}
              onOpenDetails={setSelectedDevice}
              onDeleteDevice={handleDeleteDevice}
              onRefresh={fetchData}
            />
          )}
          {activeTab === 'incidents' && (
            <IncidentManagement
              tickets={tickets}
              onAcknowledgeTicket={handleAcknowledgeTicket}
              onResolveTicket={handleResolveTicket}
            />
          )}
          {activeTab === 'backups' && (
            <BackupManager
              onTriggerBackupAll={handleTriggerBackupAll}
              isAnyBackupRunning={isAnyBackupRunning}
            />
          )}
          {activeTab === 'terminal' && (
            <CommandTerminal devices={devices} />
          )}
          {activeTab === 'pushconfig' && (
            <ConfigurationPush devices={devices} />
          )}
          {activeTab === 'topology' && (
            <NetworkTopology />
          )}
          {activeTab === 'settings' && (
            <Settings onAddDevice={handleAddDevice} />
          )}
        </div>
      </main>

      {selectedDevice && (
        <DeviceDetailModal device={selectedDevice} onClose={() => setSelectedDevice(null)} />
      )}
    </div>
  );
}

export default App;
