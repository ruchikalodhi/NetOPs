import { useEffect, useState, useMemo } from 'react';
import { 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  ClipboardList, 
  Search, 
  Clock, 
  AlertTriangle, 
  Activity, 
  Database, 
  FileText, 
  GitCompare, 
  History, 
  ShieldCheck, 
  Server
} from 'lucide-react';

// TypeScript Interfaces
interface Device {
  id: number;
  name: string;
  host: string;
  device_type: string;
  status: string;
  last_seen?: string;
  last_latency?: number;
  last_cpu?: number;
  last_memory?: number;
  is_monitored: boolean;
  region: string;
  vendor?: string;
  model?: string;
  is_locked?: boolean;
}

interface Backup {
  id: number;
  device_host: string;
  timestamp: string;
  filename?: string;
  file_name?: string;
  config_hash: string;
  status: string;
  error_message?: string;
  execution_time?: number;
  file_size?: number; // in KB
  operator?: string;
  version?: string;
  change_summary?: string;
  device_name?: string;
  device_type?: string;
  start_time?: string;
  end_time?: string;
  triggered_by?: string;
}

interface FailureLog {
  id: string;
  deviceName: string;
  host: string;
  reason: string;
  timestamp: string;
  retryCount: number;
  severity: 'high' | 'medium' | 'low';
}

interface AuditLog {
  id: number;
  timestamp: string;
  username: string;
  action: string;
  device_host: string;
  source_ip?: string;
  details: string;
  level: string;
  duration?: number;
}

interface BackupManagerProps {
  onTriggerBackupAll: () => void;
  isAnyBackupRunning: boolean;
}



export const BackupManager = ({ 
  onTriggerBackupAll, 
  isAnyBackupRunning 
}: BackupManagerProps) => {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  // Filter States
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'SUCCESS' | 'FAILED' | 'RUNNING'>('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [quickFilter, setQuickFilter] = useState<'none' | 'failed_today' | 'running_now' | 'recently_modified'>('none');

  // Modals / Detail Viewer States
  const [selectedDeviceRuns, setSelectedDeviceRuns] = useState<Device | null>(null);
  const [selectedDeviceDiff, setSelectedDeviceDiff] = useState<Device | null>(null);
  const [inspectingConfig, setInspectingConfig] = useState<{ device: Device; backup: Backup } | null>(null);
  const [runningIndividualBackups, setRunningIndividualBackups] = useState<Record<string, boolean>>({});

  // Fetch all necessary telemetry and logs
  useEffect(() => {
    const fetchBackupData = async (showLoadingSpinner = false) => {
      try {
        if (showLoadingSpinner) {
          setLoading(true);
        }
        // Fetch completed backups list
        const backupsRes = await fetch('http://localhost:8000/api/backups');
        const backupsData = await backupsRes.json();
        setBackups(backupsData);

        // Fetch audit logs
        const auditRes = await fetch('http://localhost:8000/api/audit-logs');
        const auditData = await auditRes.json();
        setAuditLogs(auditData);

        // Fetch devices list for grid mapping
        const devicesRes = await fetch('http://localhost:8000/api/devices');
        const devicesData = await devicesRes.json();
        
        // Enrich device records with vendor and model properties
        const enrichedDevices = devicesData.map((d: any) => ({
          ...d,
          vendor: d.host.startsWith('10.81') ? 'Cisco' : 'Cisco',
          model: d.host.startsWith('10.81') ? 'Catalyst 2960X' : d.name.includes('Core') ? 'Catalyst 9300' : 'Catalyst 3560'
        }));
        setDevices(enrichedDevices);
      } catch (e) {
        console.error("Failed to load backup operations telemetry:", e);
      } finally {
        if (showLoadingSpinner) {
          setLoading(false);
        }
      }
    };

    // Run initial load with loading spinner active
    fetchBackupData(true);

    // Setup periodic polling every 5 seconds silently in the background
    const interval = setInterval(() => {
      fetchBackupData(false);
    }, 5000);

    return () => clearInterval(interval);
  }, [refreshKey]);

  // Handle Refresh Action
  const handleRefresh = () => {
    setRefreshKey(prev => prev + 1);
  };

  // Single Device manual backup trigger
  const handleTriggerBackupDevice = async (host: string) => {
    setRunningIndividualBackups(prev => ({ ...prev, [host]: true }));
    try {
      const res = await fetch(`http://localhost:8000/api/devices/${host}/backup`, {
        method: 'POST'
      });
      if (res.ok) {
        // Wait a second and refresh data
        setTimeout(() => {
          handleRefresh();
        }, 1500);
      }
    } catch (e) {
      console.error(`Failed to backup device ${host}:`, e);
    } finally {
      setTimeout(() => {
        setRunningIndividualBackups(prev => ({ ...prev, [host]: false }));
      }, 1500);
    }
  };

  // Trigger download all gzipped configurations
  const handleDownloadAllZip = () => {
    window.open('http://localhost:8000/api/backups/download-zip', '_blank');
  };

  // Get regions list for filter mapping
  const regionsList = useMemo(() => {
    const list = new Set(devices.map(d => d.region));
    return Array.from(list);
  }, [devices]);

  // Derived Metrics & KPIs
  const metrics = useMemo(() => {
    const totalCount = devices.length;
    const successCount = backups.filter(b => b.status === 'SUCCESS').length;
    const failedCount = backups.filter(b => b.status !== 'SUCCESS' && b.status !== 'RUNNING').length;
    
    // Get unique devices whose LATEST backup is successful
    const protectedCount = devices.filter(d => {
      const devBackups = backups.filter(b => b.device_host === d.host);
      return devBackups.length > 0 && devBackups[0].status === 'SUCCESS';
    }).length;
    
    const complianceScore = totalCount > 0 ? Math.round((protectedCount / totalCount) * 100) : 0;
    const successRate = (successCount + failedCount) > 0 
      ? Math.round((successCount / (successCount + failedCount)) * 10000) / 100 
      : 100.0;

    // Calculate total storage
    const totalStorageKB = backups.filter(b => b.status === 'SUCCESS').length * 4.2; // average 4.2KB per gzipped cisco config
    const storageDisplay = totalStorageKB > 1024 
      ? `${(totalStorageKB / 1024).toFixed(1)} MB` 
      : `${totalStorageKB.toFixed(0)} KB`;

    // Get the latest backup time
    const latestBackup = backups[0];
    let lastBackupTime = 'Never';
    if (latestBackup) {
      const ts = latestBackup.timestamp.endsWith('Z') ? latestBackup.timestamp : `${latestBackup.timestamp}Z`;
      lastBackupTime = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

    return {
      totalDevices: totalCount,
      protectedDevices: protectedCount,
      successRate,
      failedCount: failedCount,
      backupsToday: backups.filter(b => {
        const todayStr = new Date().toDateString();
        const ts = b.timestamp.endsWith('Z') ? b.timestamp : `${b.timestamp}Z`;
        return new Date(ts).toDateString() === todayStr && b.status === 'SUCCESS';
      }).length,
      failuresToday: backups.filter(b => {
        const todayStr = new Date().toDateString();
        const ts = b.timestamp.endsWith('Z') ? b.timestamp : `${b.timestamp}Z`;
        return new Date(ts).toDateString() === todayStr && b.status !== 'SUCCESS' && b.status !== 'RUNNING';
      }).length,
      storageConsumed: storageDisplay,
      complianceScore,
      lastBackupTime
    };
  }, [backups, devices]);

  // Failure Log List Summary
  const recentFailures: FailureLog[] = useMemo(() => {
    const failedRuns = backups.filter(b => b.status !== 'SUCCESS' && b.status !== 'RUNNING').slice(0, 5);
    return failedRuns.map((f, index) => {
      const dev = devices.find(d => d.host === f.device_host);
      return {
        id: `fail-${index}`,
        deviceName: dev ? dev.name : `Switch_${f.device_host.split('.').pop()}`,
        host: f.device_host,
        reason: f.error_message || "Backup failed. Device unreachable.",
        timestamp: new Date(f.timestamp.endsWith('Z') ? f.timestamp : `${f.timestamp}Z`).toLocaleString(),
        retryCount: 3,
        severity: f.status === 'AUTH_FAILED' ? 'high' : 'medium'
      };
    });
  }, [backups, devices]);

  // Filtered Devices list for the registry
  const filteredDevices = useMemo(() => {
    return devices.filter(d => {
      // 1. Search Query (Name, IP, Region)
      const query = searchTerm.toLowerCase();
      const matchesSearch = 
        d.name.toLowerCase().includes(query) ||
        d.host.includes(query) ||
        d.region.toLowerCase().includes(query);

      if (!matchesSearch) return false;

      // 2. Region Filter
      if (regionFilter !== 'all' && d.region !== regionFilter) return false;

      // 3. Status Filter (lookup latest backup status for this host)
      const deviceBackups = backups.filter(b => b.device_host === d.host);
      const latestBackup = deviceBackups.length > 0 ? deviceBackups[0] : null;

      if (statusFilter !== 'all') {
        const isRunning = runningIndividualBackups[d.host] || d.is_locked;
        if (statusFilter === 'RUNNING') {
          if (!isRunning) return false;
        } else {
          if (isRunning) return false;
          if (!latestBackup) return false;
          
          if (statusFilter === 'SUCCESS') {
            if (latestBackup.status !== 'SUCCESS') return false;
          } else if (statusFilter === 'FAILED') {
            if (latestBackup.status !== 'FAILED' && latestBackup.status !== 'AUTH_FAILED' && latestBackup.status !== 'TIMEOUT' && latestBackup.status !== 'VALIDATION_FAILED') return false;
          } else if (statusFilter === 'UNREACHABLE') {
            if (latestBackup.status !== 'UNREACHABLE') return false;
          } else if (statusFilter === 'AUTH_FAILED') {
            if (latestBackup.status !== 'AUTH_FAILED') return false;
          } else if (statusFilter === 'TIMEOUT') {
            if (latestBackup.status !== 'TIMEOUT') return false;
          } else if (statusFilter === 'VALIDATION_FAILED') {
            if (latestBackup.status !== 'VALIDATION_FAILED') return false;
          }
        }
      }

      // 4. Quick Filters
      if (quickFilter === 'failed_today') {
        const hasFailedToday = deviceBackups.some(b => {
          const today = new Date().toDateString();
          const ts = b.timestamp.endsWith('Z') ? b.timestamp : `${b.timestamp}Z`;
          return new Date(ts).toDateString() === today && b.status !== 'SUCCESS' && b.status !== 'RUNNING';
        });
        if (!hasFailedToday) return false;
      }
      if (quickFilter === 'running_now') {
        if (!runningIndividualBackups[d.host] && !isAnyBackupRunning) return false;
      }
      if (quickFilter === 'recently_modified') {
        if (!latestBackup) return false;
        const diffMs = Date.now() - new Date(latestBackup.timestamp).getTime();
        if (diffMs > 3600000 * 2) return false; // modified in last 2 hours
      }

      return true;
    });
  }, [devices, backups, searchTerm, regionFilter, statusFilter, quickFilter, runningIndividualBackups, isAnyBackupRunning]);

  // Mock historical runs helper
  const getDeviceBackupRuns = (deviceHost: string): Backup[] => {
    const actual = backups.filter(b => b.device_host === deviceHost);
    if (actual.length > 0) return actual;

    // Fallback Mock runs for visualization
    return [
      {
        id: 1001,
        device_host: deviceHost,
        timestamp: new Date(Date.now() - 3600000).toISOString(),
        config_hash: '8f3b2d1c9e8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e',
        status: 'SUCCESS',
        execution_time: 1.48,
        file_size: 4.3,
        operator: 'admin',
        version: 'v1.1',
        change_summary: 'Added VLAN 30 Security and updated trunk configuration.'
      },
      {
        id: 1002,
        device_host: deviceHost,
        timestamp: new Date(Date.now() - 3600000 * 24).toISOString(),
        config_hash: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e',
        status: 'SUCCESS',
        execution_time: 1.25,
        file_size: 4.1,
        operator: 'admin',
        version: 'v1.0',
        change_summary: 'Initial NOC database backup.'
      }
    ];
  };


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      
      {/* 1. TOP ENTERPRISE SUMMARY CARDS GRID */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '15px' }}>
        {/* Total Devices */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Total Devices</span>
            <Server size={18} color="var(--primary)" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{metrics.totalDevices}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Configured in NOC Inventory</div>
        </div>

        {/* Protected Devices */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Protected Nodes</span>
            <ShieldCheck size={18} color="var(--color-up)" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--color-up)' }}>{metrics.protectedDevices}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>With successful backups</div>
        </div>

        {/* Compliance Score */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Compliance Score</span>
            <Activity size={18} color="var(--primary)" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800 }}>{metrics.complianceScore}%</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Target: 100% protection</div>
        </div>

        {/* Success Rate */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Success Rate</span>
            <CheckCircle2 size={18} color="var(--color-up)" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--color-up)' }}>{metrics.successRate}%</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Average execution score</div>
        </div>

        {/* Failures Today */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Failures Today</span>
            <XCircle size={18} color={metrics.failuresToday > 0 ? 'var(--color-down)' : 'var(--text-muted)'} />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: metrics.failuresToday > 0 ? 'var(--color-down)' : 'inherit' }}>
            {metrics.failuresToday}
          </div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Requires immediate inspection</div>
        </div>

        {/* Storage Consumed */}
        <div className="glass-panel" style={{ padding: '15px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>Storage Saved</span>
            <Database size={18} color="var(--accent)" />
          </div>
          <div style={{ fontSize: '1.6rem', fontWeight: 800, color: 'var(--accent)' }}>{metrics.storageConsumed}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px' }}>Gzip compressed backup registry</div>
        </div>
      </div>

      {/* 2. TWO-PANEL OPERATIONS LAYOUT */}
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '20px', alignItems: 'start' }}>
        
        {/* LEFT PANEL: Backup Control Center */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          
          {/* Backup Control Card */}
          <div className="glass-panel" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
              <Database size={18} color="var(--primary)" />
              <h4 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Backup Control</h4>
            </div>
            
            <p className="text-muted" style={{ fontSize: '0.78rem', marginBottom: '15px', lineHeight: '1.4' }}>
              Trigger a parallel configuration backup routine across all active network nodes.
            </p>

            {/* Run Backup Button */}
            <button 
              className="btn btn-primary"
              onClick={onTriggerBackupAll}
              disabled={isAnyBackupRunning}
              style={{ width: '100%', padding: '12px', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', fontSize: '0.85rem', fontWeight: 700, filter: 'drop-shadow(0 0 8px rgba(0, 229, 255, 0.2))', marginBottom: '15px' }}
            >
              <RefreshCw size={14} className={isAnyBackupRunning ? 'spin' : ''} />
              {isAnyBackupRunning ? 'Running Backups...' : 'Run Backup (All Devices)'}
            </button>

            {/* Status Info Box */}
            <div style={{ padding: '12px', background: 'rgba(5, 7, 12, 0.6)', border: '1px solid var(--border-color)', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '0.8rem' }}>
              <div className="flex-between">
                <span className="text-muted">Success Rate:</span>
                <span style={{ color: 'var(--color-up)', fontWeight: 700 }}>{metrics.successRate}%</span>
              </div>
              <div className="flex-between">
                <span className="text-muted">Failed Runs:</span>
                <span style={{ color: 'var(--color-down)', fontWeight: 700 }}>{metrics.failedCount}</span>
              </div>
              <div className="flex-between">
                <span className="text-muted">Last Backup:</span>
                <span className="mono" style={{ fontWeight: 600 }}>{metrics.lastBackupTime}</span>
              </div>
            </div>

            {/* Secondary Action Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginTop: '15px' }}>
              <button className="btn btn-secondary" style={{ padding: '8px', fontSize: '0.75rem' }} title="Configure automatic schedules" onClick={() => alert("Backups scheduled automatically (Every 5 minutes).")}>
                Schedule
              </button>
              <button className="btn btn-secondary" style={{ padding: '8px', fontSize: '0.75rem' }} title="Bulk download configs in a ZIP file" onClick={handleDownloadAllZip}>
                Export ZIP
              </button>
            </div>
          </div>

          {/* Failure Log Summary Card */}
          <div className="glass-panel" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
              <AlertTriangle size={18} color="var(--color-down)" />
              <h4 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Recent Failure Log Summary</h4>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {recentFailures.length > 0 ? (
                recentFailures.map(f => (
                  <div key={f.id} style={{ padding: '10px', background: 'rgba(239, 68, 68, 0.04)', border: '1px solid rgba(239, 68, 68, 0.15)', borderRadius: '8px', fontSize: '0.75rem' }}>
                    <div className="flex-between" style={{ marginBottom: '4px' }}>
                      <span className="mono" style={{ color: 'var(--color-down)', fontWeight: 600 }}>
                        {f.deviceName}
                      </span>
                      <span className="mono text-muted" style={{ fontSize: '0.65rem' }}>
                        {f.timestamp.split(',')[1]?.trim() || f.timestamp}
                      </span>
                    </div>
                    <div className="mono text-muted" style={{ fontSize: '0.7rem', marginBottom: '6px' }}>
                      {f.host}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', lineHeight: '1.3' }}>
                      {f.reason}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ textAlign: 'center', padding: '20px 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  No backup failures logged recently.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: Individual Device Backups Table & Filtering */}
        <div className="glass-panel" style={{ padding: '20px', minHeight: '600px' }}>
          
          <div className="flex-between" style={{ marginBottom: '20px', gap: '10px', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ClipboardList size={20} color="var(--primary)" />
              <h3>Individual Device Backups</h3>
            </div>

            <div className="flex-gap-10">
              {/* Refresh Button */}
              <button 
                className="btn btn-secondary" 
                onClick={handleRefresh}
                style={{ padding: '8px 12px' }}
                title="Refresh Registry"
              >
                <RefreshCw size={14} className={loading ? 'spin' : ''} />
              </button>
            </div>
          </div>

          {/* Search, Filters & Toolbar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '15px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '10px' }}>
              {/* Search */}
              <div style={{ position: 'relative' }}>
                <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                <input
                  type="text"
                  placeholder="Search Switch Name, IP, Region..."
                  className="form-control"
                  style={{ paddingLeft: '32px', height: '34px', fontSize: '0.8rem' }}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>

              {/* Status Filter */}
              <select
                className="form-control"
                style={{ height: '34px', fontSize: '0.8rem', padding: '0 8px' }}
                value={statusFilter}
                onChange={(e: any) => setStatusFilter(e.target.value)}
              >
                <option value="all">All States</option>
                <option value="SUCCESS">Successful</option>
                <option value="FAILED">Failed (General)</option>
                <option value="RUNNING">Running</option>
                <option value="UNREACHABLE">Unreachable</option>
                <option value="AUTH_FAILED">Auth Failed</option>
                <option value="TIMEOUT">SSH Timeout</option>
                <option value="VALIDATION_FAILED">Validation Failed</option>
              </select>

              {/* Region Filter */}
              <select
                className="form-control"
                style={{ height: '34px', fontSize: '0.8rem', padding: '0 8px' }}
                value={regionFilter}
                onChange={(e) => setRegionFilter(e.target.value)}
              >
                <option value="all">All Regions</option>
                {regionsList.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>

            {/* Quick Filters pills */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginRight: '4px' }}>Quick Filters:</span>
              <button
                className={`btn ${quickFilter === 'failed_today' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '4px 10px', fontSize: '0.7rem' }}
                onClick={() => setQuickFilter(prev => prev === 'failed_today' ? 'none' : 'failed_today')}
              >
                Failed Today
              </button>
              <button
                className={`btn ${quickFilter === 'running_now' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '4px 10px', fontSize: '0.7rem' }}
                onClick={() => setQuickFilter(prev => prev === 'running_now' ? 'none' : 'running_now')}
              >
                Running Now
              </button>
              <button
                className={`btn ${quickFilter === 'recently_modified' ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '4px 10px', fontSize: '0.7rem' }}
                onClick={() => setQuickFilter(prev => prev === 'recently_modified' ? 'none' : 'recently_modified')}
              >
                Recently Modified
              </button>
            </div>
          </div>

          {/* Main Registry Data Grid */}
          <div className="table-scroll-wrapper" style={{ maxHeight: '600px', overflowY: 'auto' }}>
            {loading && backups.length === 0 ? (
              <div className="text-center" style={{ padding: '60px 0' }}>
                <RefreshCw size={28} className="spin" style={{ color: 'var(--primary)' }} />
                <p style={{ marginTop: '12px', color: 'var(--text-muted)' }}>Querying backup registry...</p>
              </div>
            ) : filteredDevices.length > 0 ? (
              <table className="custom-table" style={{ fontSize: '0.85rem', width: '100%', tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '22%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '28%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th>NAME</th>
                    <th>IP ADDRESS</th>
                    <th>REGION</th>
                    <th>BACKUP STATE</th>
                    <th style={{ textAlign: 'right' }}>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDevices.map(d => {
                    const devBackups = backups.filter(b => b.device_host === d.host);
                    const latestBackup = devBackups.length > 0 ? devBackups[0] : null;
                    const isRunning = runningIndividualBackups[d.host] || d.is_locked;

                    let stateLabel = 'Unbacked';
                    let stateColor = 'var(--text-muted)';
                    let stateBg = 'rgba(255, 255, 255, 0.05)';
                    let stateBorder = 'rgba(255, 255, 255, 0.1)';
                    let StateIcon = Clock;

                    if (isRunning) {
                      stateLabel = 'Running';
                      stateColor = 'var(--primary)';
                      stateBg = 'rgba(0, 229, 255, 0.06)';
                      stateBorder = 'rgba(0, 229, 255, 0.2)';
                      StateIcon = RefreshCw;
                    } else if (latestBackup) {
                      if (latestBackup.status === 'SUCCESS') {
                        stateLabel = 'Successful';
                        stateColor = 'var(--color-up)';
                        stateBg = 'rgba(16, 185, 129, 0.06)';
                        stateBorder = 'rgba(16, 185, 129, 0.2)';
                        StateIcon = CheckCircle2;
                      } else if (latestBackup.status === 'UNREACHABLE') {
                        stateLabel = 'Unreachable';
                        stateColor = 'orange';
                        stateBg = 'rgba(245, 158, 11, 0.06)';
                        stateBorder = 'rgba(245, 158, 11, 0.2)';
                        StateIcon = AlertTriangle;
                      } else if (latestBackup.status === 'AUTH_FAILED') {
                        stateLabel = 'Auth Failed';
                        stateColor = 'var(--color-down)';
                        stateBg = 'rgba(239, 68, 68, 0.06)';
                        stateBorder = 'rgba(239, 68, 68, 0.2)';
                        StateIcon = XCircle;
                      } else if (latestBackup.status === 'TIMEOUT') {
                        stateLabel = 'Timeout';
                        stateColor = 'var(--color-down)';
                        stateBg = 'rgba(239, 68, 68, 0.06)';
                        stateBorder = 'rgba(239, 68, 68, 0.2)';
                        StateIcon = Clock;
                      } else if (latestBackup.status === 'VALIDATION_FAILED') {
                        stateLabel = 'Validation Failed';
                        stateColor = 'var(--color-down)';
                        stateBg = 'rgba(239, 68, 68, 0.06)';
                        stateBorder = 'rgba(239, 68, 68, 0.2)';
                        StateIcon = AlertTriangle;
                      } else {
                        stateLabel = 'Failed';
                        stateColor = 'var(--color-down)';
                        stateBg = 'rgba(239, 68, 68, 0.06)';
                        stateBorder = 'rgba(239, 68, 68, 0.2)';
                        StateIcon = XCircle;
                      }
                    }

                    return (
                      <tr key={d.id} style={{ height: '48px' }}>
                        {/* Device Name */}
                        <td className="mono truncate" style={{ fontWeight: 700 }} title={d.name}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span>{d.name}</span>
                          </div>
                        </td>

                        {/* IP Address */}
                        <td className="mono">{d.host}</td>

                        {/* Region */}
                        <td>{d.region}</td>

                        {/* Backup State Badge */}
                        <td>
                          <span className="status-badge" style={{
                            fontSize: '0.72rem',
                            padding: '3px 8px',
                            background: stateBg,
                            color: stateColor,
                            borderColor: stateBorder,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '4px',
                            fontWeight: 600
                          }}>
                            <StateIcon size={12} className={isRunning ? 'spin' : ''} />
                            {stateLabel}
                          </span>
                        </td>

                        {/* Actions */}
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'inline-flex', gap: '6px' }}>
                            {/* Inspect Runs Button */}
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '6px 10px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => setSelectedDeviceRuns(d)}
                              title="Inspect backup run history"
                            >
                              <History size={12} />
                              Inspect Runs
                            </button>

                            {/* View Diff/Config Button */}
                            <button
                              className="btn btn-secondary"
                              style={{ padding: '6px 10px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => setSelectedDeviceDiff(d)}
                              title="Compare config versions"
                            >
                              <GitCompare size={12} />
                              Compare Versions
                            </button>

                            {/* Trigger Backup Button */}
                            <button
                              className="btn btn-primary"
                              style={{ padding: '6px 10px', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}
                              onClick={() => handleTriggerBackupDevice(d.host)}
                              disabled={isRunning || isAnyBackupRunning}
                              title="Run manual config backup job"
                            >
                              <RefreshCw size={12} className={isRunning ? 'spin' : ''} />
                              Backup
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="text-center text-muted" style={{ padding: '60px 0' }}>
                No devices match current filters.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. ADMINISTRATIVE AUDIT TRAIL LOGS */}
      <div className="glass-panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '15px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <ClipboardList size={18} color="var(--primary)" />
            <h4 style={{ fontSize: '1.05rem', fontWeight: 700 }}>Administrative Audit Trail</h4>
          </div>
        </div>

        <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
          {loading && auditLogs.length === 0 ? (
            <div className="text-center" style={{ padding: '30px 0' }}>
              <p className="text-muted">Loading logs...</p>
            </div>
          ) : auditLogs.length > 0 ? (
            <div className="audit-list">
              {auditLogs.map(log => {
                let statusClass = '';
                if (log.action.includes('SUCCESS') || log.action === 'BACKUP_DEVICE' || log.action === 'INCIDENT_RESOLVED') {
                  statusClass = 'backup-success';
                } else if (log.action.includes('FAILED') || log.action.includes('ERROR') || log.action.includes('OUTAGE')) {
                  statusClass = 'backup-fail';
                }

                return (
                  <div key={log.id} className={`audit-item ${statusClass}`} style={{ fontSize: '0.78rem' }}>
                    <div className="audit-time">
                      {new Date(log.timestamp).toLocaleString()} | Operator: {log.username}
                    </div>
                    <div className="audit-title">
                      <span>{log.action}</span>
                      <span className="mono" style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600 }}>
                        {log.device_host || 'Global'}
                      </span>
                    </div>
                    <div className="audit-desc" style={{ marginTop: '3px' }}>
                      {log.details}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              No audit logs captured.
            </div>
          )}
        </div>
      </div>

      {/* 4. MODALS & SLIDE-OUT SHEETS */}
      
      {/* A. Inspect Runs Modal */}
      {selectedDeviceRuns && (() => {
        const deviceRuns = getDeviceBackupRuns(selectedDeviceRuns.host);
        return (
          <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0, 0, 0, 0.75)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div className="glass-panel" style={{ width: '90%', maxWidth: '900px', padding: '25px', boxShadow: '0 0 30px rgba(0, 229, 255, 0.1)' }}>
              <div className="flex-between" style={{ marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <History size={20} color="var(--primary)" />
                  <div>
                    <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Backup History Registry</h3>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{selectedDeviceRuns.name} ({selectedDeviceRuns.host})</p>
                  </div>
                </div>
                <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setSelectedDeviceRuns(null)}>
                  Close
                </button>
              </div>

              <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                <table className="custom-table" style={{ fontSize: '0.78rem', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '12%' }}>STATUS</th>
                      <th style={{ width: '18%' }}>START TIME</th>
                      <th style={{ width: '18%' }}>END TIME</th>
                      <th style={{ width: '8%' }}>DURATION</th>
                      <th style={{ width: '26%' }}>BACKUP FILE / FAILURE REASON</th>
                      <th style={{ width: '10%' }}>OPERATOR</th>
                      <th style={{ width: '8%', textAlign: 'right' }}>ACTION</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deviceRuns.map(r => {
                      let statusColor = 'var(--text-muted)';
                      let statusBg = 'rgba(255, 255, 255, 0.05)';
                      if (r.status === 'SUCCESS') {
                        statusColor = 'var(--color-up)';
                        statusBg = 'rgba(16, 185, 129, 0.08)';
                      } else if (r.status === 'UNREACHABLE') {
                        statusColor = 'orange';
                        statusBg = 'rgba(245, 158, 11, 0.08)';
                      } else if (r.status === 'AUTH_FAILED' || r.status === 'TIMEOUT' || r.status === 'VALIDATION_FAILED' || r.status === 'FAILED') {
                        statusColor = 'var(--color-down)';
                        statusBg = 'rgba(239, 68, 68, 0.08)';
                      }

                      const startTimeStr = r.start_time ? new Date(r.start_time).toLocaleString() : new Date(r.timestamp).toLocaleString();
                      const endTimeStr = r.end_time ? new Date(r.end_time).toLocaleString() : new Date(r.timestamp).toLocaleString();
                      const durationStr = r.execution_time ? `${r.execution_time.toFixed(2)}s` : '--';
                      const operatorStr = r.triggered_by || r.operator || 'system';
                      const isSuccess = r.status === 'SUCCESS';
                      const detailsText = isSuccess ? (r.filename || r.file_name || 'N/A') : (r.error_message || 'N/A');

                      return (
                        <tr key={r.id}>
                          <td>
                            <span className="status-badge" style={{
                              fontSize: '0.68rem',
                              padding: '2px 6px',
                              background: statusBg,
                              color: statusColor,
                              borderColor: 'transparent',
                              fontWeight: 700
                            }}>
                              {r.status}
                            </span>
                          </td>
                          <td>{startTimeStr}</td>
                          <td>{endTimeStr}</td>
                          <td className="mono">{durationStr}</td>
                          <td className="mono truncate" title={detailsText} style={{ color: isSuccess ? '#80ffc0' : '#ff8080', maxWidth: '220px' }}>
                            {detailsText}
                          </td>
                          <td>{operatorStr}</td>
                          <td style={{ textAlign: 'right' }}>
                            {isSuccess ? (
                              <button
                                className="btn btn-secondary"
                                style={{ padding: '4px 8px', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                                onClick={() => setInspectingConfig({ device: selectedDeviceRuns, backup: r })}
                              >
                                <FileText size={10} />
                                View
                              </button>
                            ) : (
                              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>--</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        );
      })()}

      {/* B. View Config File Content Modal */}
      {inspectingConfig && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0, 0, 0, 0.8)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '700px', padding: '25px', boxShadow: '0 0 40px rgba(0,229,255,0.15)' }}>
            <div className="flex-between" style={{ marginBottom: '15px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
              <div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Cisco Configuration File</h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{inspectingConfig.device.name} - Version {inspectingConfig.backup.version || 'v1.0'} ({inspectingConfig.backup.file_size || '4.2'} KB)</p>
              </div>
              <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setInspectingConfig(null)}>
                Back
              </button>
            </div>

            <pre style={{
              background: 'rgba(5, 7, 12, 0.95)',
              border: '1px solid var(--border-color)',
              borderRadius: '8px',
              padding: '15px',
              color: '#00ffc0',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              maxHeight: '400px',
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              textAlign: 'left'
            }}>
              {/* Config view removed - download backup to view */}
            </pre>
          </div>
        </div>
      )}

      {/* C. Compare Versions Diff Modal */}
      {selectedDeviceDiff && (
        <div className="modal-overlay" style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0, 0, 0, 0.82)', backdropFilter: 'blur(5px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="glass-panel" style={{ width: '100%', maxWidth: '950px', padding: '25px', boxShadow: '0 0 50px rgba(0, 229, 255, 0.15)' }}>
            <div className="flex-between" style={{ marginBottom: '20px', borderBottom: '1px solid var(--border-color)', paddingBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <GitCompare size={20} color="var(--primary)" />
                <div>
                  <h3 style={{ fontSize: '1.2rem', fontWeight: 800 }}>Configuration Difference Viewer</h3>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Comparing Old Version (v1.0) vs Current Active running-config (v1.1) for {selectedDeviceDiff.name}</p>
                </div>
              </div>
              <button className="btn btn-secondary" style={{ padding: '6px 12px' }} onClick={() => setSelectedDeviceDiff(null)}>
                Close Viewer
              </button>
            </div>

            {renderConfigDiff()}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
              <button className="btn btn-secondary" onClick={() => alert("Configurations are locked. Rollback disabled in demo mode.")}>
                Rollback to v1.0
              </button>
              <button className="btn btn-primary" onClick={() => setSelectedDeviceDiff(null)}>
                Acknowledge Diff
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
