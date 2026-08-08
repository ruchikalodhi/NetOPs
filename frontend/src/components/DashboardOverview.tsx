import React, { useState, useEffect, useMemo } from 'react';
import {
  Server,
  Activity,
  Database,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  Wifi,
  WifiOff,
  Radio,
  MonitorOff,
  Wind,
  Zap,
  Thermometer,
  Network,
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';

interface Ticket {
  id: string;
  deviceName: string;
  host: string;
  detectedTime: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'open' | 'acknowledged' | 'resolved';
  resolvedTime?: string;
  lastUpdated?: string;
  category?: string;
  component_type?: string;
  component_name?: string;
  interface_name?: string;
  interface_mode?: string;
  interface_oper_state?: string;
}

interface LatencyPoint {
  time: string;
  latency: number;
}

interface DashboardOverviewProps {
  stats: any;
  devices: any[];
  tickets: Ticket[];
  onAcknowledgeTicket: (id: string) => void;
  onResolveTicket: (id: string) => void;
}

// Telemetry status banner
const TelemetryBanner: React.FC<{ status: string; label: string; detail: string }> = ({ status, label, detail }) => {
  const configs: Record<string, { color: string; bg: string; Icon: React.FC<any> }> = {
    real_time:          { color: 'var(--color-up)',      bg: 'rgba(16,185,129,0.08)',  Icon: Wifi },
    no_telemetry:       { color: 'var(--color-degraded)', bg: 'rgba(245,158,11,0.08)', Icon: Radio },
    device_unreachable: { color: 'var(--color-down)',    bg: 'rgba(239,68,68,0.08)',   Icon: WifiOff },
    monitoring_disabled:{ color: 'var(--text-muted)',    bg: 'rgba(100,116,139,0.08)', Icon: MonitorOff },
  };
  const cfg = configs[status] ?? configs.no_telemetry;
  const { color, bg, Icon } = cfg;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '10px 16px', borderRadius: '8px', marginBottom: '20px',
      background: bg, border: `1px solid ${color}22`,
    }}>
      <Icon size={16} color={color} />
      <span style={{ color, fontWeight: 700, fontSize: '0.85rem' }}>{label}</span>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>{detail}</span>
    </div>
  );
};

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  stats,
  devices,
  tickets,
  onAcknowledgeTicket: _onAcknowledgeTicket,
  onResolveTicket: _onResolveTicket,
}) => {
  const [activeFilter, setActiveFilter] = useState<'all'|'open'|'acknowledged'|'resolved'|'critical'|'major'|'medium'|'minor'|'warning'|'low'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<'deviceName'|'status'|'severity'|'detectedTime'>('detectedTime');
  const [sortDirection, setSortDirection] = useState<'asc'|'desc'>('desc');
  const [regions, setRegions] = useState<any[]>([]);
  const [latencyHistory, setLatencyHistory] = useState<LatencyPoint[]>([]);
  const [telemetryStatus, setTelemetryStatus] = useState<{status:string;label:string;detail:string}|null>(null);

  // Fetch regional data
  useEffect(() => {
    const fetchRegions = async () => {
      try {
        const res = await fetch('http://localhost:8000/api/metrics/regions');
        if (res.ok) setRegions(await res.json());
      } catch (e) { console.error('Failed to fetch regional metrics:', e); }
    };
    fetchRegions();
    const iv = setInterval(fetchRegions, 10000);
    return () => clearInterval(iv);
  }, []);

  // Fetch real latency history from a representative online device
  useEffect(() => {
    const fetchLatencyHistory = async () => {
      const onlineDevice = devices.find(d => d.status === 'UP' || d.status === 'DEGRADED');
      if (!onlineDevice) { setLatencyHistory([]); return; }
      try {
        const res = await fetch(`http://localhost:8000/api/devices/${onlineDevice.host}/metrics?limit=24`);
        if (!res.ok) { setLatencyHistory([]); return; }
        const data: any[] = await res.json();
        const points: LatencyPoint[] = data
          .filter(m => m.latency > 0)
          .map(m => ({
            time: new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            latency: Math.round(m.latency * 10) / 10,
          }));
        setLatencyHistory(points);
      } catch (e) { setLatencyHistory([]); }
    };
    fetchLatencyHistory();
    const iv = setInterval(fetchLatencyHistory, 15000);
    return () => clearInterval(iv);
  }, [devices]);

  // Fetch telemetry status indicator
  useEffect(() => {
    const fetchTelemetry = async () => {
      try {
        const res = await fetch('http://localhost:8000/api/telemetry/status');
        if (res.ok) setTelemetryStatus(await res.json());
      } catch (e) {}
    };
    fetchTelemetry();
    const iv = setInterval(fetchTelemetry, 10000);
    return () => clearInterval(iv);
  }, []);

  // Filter and sort tickets
  const filteredTickets = useMemo(() => {
    if (!tickets) return [];
    return tickets.filter(t => {
      if (activeFilter === 'open'         && t.status   !== 'open')         return false;
      if (activeFilter === 'acknowledged' && t.status   !== 'acknowledged') return false;
      if (activeFilter === 'resolved'     && t.status   !== 'resolved')     return false;
      if (activeFilter === 'critical' && t.severity !== 'critical') return false;
      if (activeFilter === 'major'    && t.severity !== 'major')    return false;
      if (activeFilter === 'medium'   && t.severity !== 'medium')   return false;
      if (activeFilter === 'minor'    && t.severity !== 'minor')    return false;
      if (activeFilter === 'warning'  && t.severity !== 'warning')  return false;
      if (activeFilter === 'low'      && t.severity !== 'low')      return false;
      const q = searchTerm.toLowerCase();
      return (
        t.deviceName.toLowerCase().includes(q) ||
        t.host.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
      );
    });
  }, [tickets, activeFilter, searchTerm]);

  const sortedTickets = useMemo(() => {
    const sorted = [...filteredTickets];
    sorted.sort((a, b) => {
      let valA: any = a[sortField] || '';
      let valB: any = b[sortField] || '';
      if (sortField === 'severity') {
        const w = { critical: 4, high: 3, medium: 2, low: 1 };
        valA = w[a.severity as keyof typeof w] || 0;
        valB = w[b.severity as keyof typeof w] || 0;
      } else if (sortField === 'status') {
        const w = { open: 3, acknowledged: 2, resolved: 1 };
        valA = w[a.status as keyof typeof w] || 0;
        valB = w[b.status as keyof typeof w] || 0;
      }
      if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
      if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredTickets, sortField, sortDirection]);

  if (!stats) return <div className="glass-panel text-center">Loading dashboard analytics...</div>;

  // Summary card counts from real data only
  const onlineCount  = stats.devices?.online  ?? (stats.devices.up + (stats.devices.degraded ?? 0));
  const offlineCount = stats.devices?.offline ?? stats.devices.down;
  const avgLatency   = stats.averages?.latency; // null → "N/A"

  // Ping RTO alerts
  const activeRtoCount = devices.filter(
    d => d.status === 'DOWN' || (d.last_packet_loss !== undefined && d.last_packet_loss > 0)
  ).length;

  // Charts data
  const statusData = [
    { name: 'Up',      value: stats.devices.up,      color: 'hsl(145, 80%, 45%)' },
    { name: 'Degraded',value: stats.devices.degraded, color: 'hsl(35, 92%, 55%)' },
    { name: 'Down',    value: stats.devices.down,     color: 'hsl(355, 90%, 55%)' },
    { name: 'Unknown', value: stats.devices.unknown,  color: 'hsl(215, 15%, 45%)' },
  ].filter(d => d.value > 0);

  const utilizationData = [...devices]
    .filter(d => d.status !== 'DOWN' && d.status !== 'UNKNOWN')
    .sort((a, b) => b.last_cpu - a.last_cpu)
    .slice(0, 6)
    .map(d => ({ name: d.name || d.host, CPU: d.last_cpu, Memory: d.last_memory }));

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortDirection(p => p === 'asc' ? 'desc' : 'asc');
    else { setSortField(field); setSortDirection('desc'); }
  };

  const renderSortIcon = (field: typeof sortField) => {
    if (sortField !== field) return <ArrowUpDown size={12} style={{ marginLeft: '4px', opacity: 0.5 }} />;
    return sortDirection === 'asc'
      ? <ArrowUp   size={12} style={{ marginLeft: '4px', color: 'var(--primary)' }} />
      : <ArrowDown size={12} style={{ marginLeft: '4px', color: 'var(--primary)' }} />;
  };

  const getDeviceState = (host: string) => {
    const dev = devices.find(d => d.host === host);
    return dev ? dev.status : 'UNKNOWN';
  };

  return (
    <div>
      {/* Telemetry Status Banner */}
      {telemetryStatus && (
        <TelemetryBanner
          status={telemetryStatus.status}
          label={telemetryStatus.label}
          detail={telemetryStatus.detail}
        />
      )}

      {/* Summary Cards */}
      <div className="stats-grid">
        {/* Total Devices */}
        <div className="glass-panel stat-card">
          <div className="stat-header">
            <span>Total Inspected Devices</span>
            <Server size={18} color="var(--primary)" />
          </div>
          <div className="stat-value">{stats.devices.total}</div>
          <div className="stat-footer">Active and configured in Inventory</div>
        </div>

        {/* Online Devices – reachable only */}
        <div className="glass-panel stat-card up">
          <div className="stat-header">
            <span>Online &amp; Reachable</span>
            <CheckCircle2 size={18} color="var(--color-up)" />
          </div>
          <div className="stat-value text-up" style={{ color: 'var(--color-up)' }}>
            {onlineCount}
          </div>
          <div className="stat-footer">
            {stats.devices.degraded > 0 ? (
              <span className="flex-gap-10" style={{ color: 'var(--color-degraded)' }}>
                <AlertTriangle size={14} /> {stats.devices.degraded} Degraded
              </span>
            ) : (
              onlineCount > 0 ? 'All services responding normally' : 'No devices online yet'
            )}
          </div>
        </div>

        {/* Offline Devices – unreachable only */}
        <div className="glass-panel stat-card down">
          <div className="stat-header">
            <span>Offline Devices</span>
            <XCircle size={18} color="var(--color-down)" />
          </div>
          <div className="stat-value" style={{ color: offlineCount > 0 ? 'var(--color-down)' : 'var(--text-primary)' }}>
            {offlineCount}
          </div>
          <div className="stat-footer">
            {offlineCount > 0 ? 'Urgent attention required' : 'No connection failures detected'}
          </div>
        </div>

        {/* Ping RTO Alerts */}
        <div
          className={`glass-panel stat-card ${activeRtoCount > 0 ? 'down' : 'up'}`}
          style={activeRtoCount > 0 ? { border: '1px solid var(--color-down)', boxShadow: '0 0 15px rgba(239,68,68,0.15)' } : {}}
        >
          <div className="stat-header">
            <span>Ping RTO Alerts</span>
            <AlertTriangle size={18} color={activeRtoCount > 0 ? 'var(--color-down)' : 'var(--color-up)'} />
          </div>
          <div className="stat-value" style={{ color: activeRtoCount > 0 ? 'var(--color-down)' : 'var(--color-up)' }}>
            {activeRtoCount} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>Active</span>
          </div>
          <div className="stat-footer">
            {activeRtoCount > 0 ? `${activeRtoCount} device(s) experiencing RTO/drops` : 'All ping paths clear (0% loss)'}
          </div>
        </div>

        {/* Switch Health Cards */}
        {stats.switch_health && (
          <>
            <div className="glass-panel stat-card" style={stats.switch_health.fan_failures > 0 ? { border: '1px solid var(--color-degraded)' } : {}}>
              <div className="stat-header">
                <span>Fan Failures</span>
                <Wind size={18} color={stats.switch_health.fan_failures > 0 ? 'var(--color-degraded)' : 'var(--text-muted)'} />
              </div>
              <div className="stat-value" style={{ color: stats.switch_health.fan_failures > 0 ? 'var(--color-degraded)' : 'var(--text-muted)' }}>
                {stats.switch_health.fan_failures}
              </div>
              <div className="stat-footer">{stats.switch_health.fan_failures > 0 ? 'Active fan failures' : 'All fans operating normally'}</div>
            </div>

            <div className="glass-panel stat-card" style={stats.switch_health.psu_failures > 0 ? { border: '1px solid var(--color-down)' } : {}}>
              <div className="stat-header">
                <span>PSU Failures</span>
                <Zap size={18} color={stats.switch_health.psu_failures > 0 ? 'var(--color-down)' : 'var(--text-muted)'} />
              </div>
              <div className="stat-value" style={{ color: stats.switch_health.psu_failures > 0 ? 'var(--color-down)' : 'var(--text-muted)' }}>
                {stats.switch_health.psu_failures}
              </div>
              <div className="stat-footer">{stats.switch_health.psu_failures > 0 ? 'Power supply critical' : 'Power supplies healthy'}</div>
            </div>

            <div className="glass-panel stat-card" style={stats.switch_health.thermal_alerts > 0 ? { border: '1px solid var(--color-down)' } : {}}>
              <div className="stat-header">
                <span>Thermal Alerts</span>
                <Thermometer size={18} color={stats.switch_health.thermal_alerts > 0 ? 'var(--color-down)' : 'var(--text-muted)'} />
              </div>
              <div className="stat-value" style={{ color: stats.switch_health.thermal_alerts > 0 ? 'var(--color-down)' : 'var(--text-muted)' }}>
                {stats.switch_health.thermal_alerts}
              </div>
              <div className="stat-footer">{stats.switch_health.thermal_alerts > 0 ? 'Temperature threshold exceeded' : 'Thermal status normal'}</div>
            </div>

            <div className="glass-panel stat-card" style={stats.switch_health.interface_incidents > 0 ? { border: '1px solid var(--color-degraded)' } : {}}>
              <div className="stat-header">
                <span>Interface Incidents</span>
                <Network size={18} color={stats.switch_health.interface_incidents > 0 ? 'var(--color-degraded)' : 'var(--text-muted)'} />
              </div>
              <div className="stat-value" style={{ color: stats.switch_health.interface_incidents > 0 ? 'var(--color-degraded)' : 'var(--text-muted)' }}>
                {stats.switch_health.interface_incidents}
              </div>
              <div className="stat-footer">{stats.switch_health.interface_incidents > 0 ? 'Active interface incidents' : 'All interfaces operational'}</div>
            </div>
          </>
        )}

        {/* Average Latency – N/A when no online devices */}
        <div className="glass-panel stat-card">
          <div className="stat-header">
            <span>Average Network Latency</span>
            <Clock size={18} color="var(--primary)" />
          </div>
          <div className="stat-value">
            {avgLatency !== null && avgLatency !== undefined
              ? <>{avgLatency} <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>ms</span></>
              : <span style={{ fontSize: '1.6rem', color: 'var(--text-muted)' }}>N/A</span>
            }
          </div>
          <div className="stat-footer">
            {avgLatency !== null && avgLatency !== undefined
              ? 'Across online routers/switches'
              : 'No online devices to measure'}
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="charts-grid">
        {/* Real Latency History – database-driven */}
        <div className="glass-panel">
          <div className="chart-title">
            <span>Network Latency History (Real-Time)</span>
            <Activity size={16} color="var(--primary)" />
          </div>
          <div style={{ width: '100%', height: 300 }}>
            {latencyHistory.length > 0 ? (
              <ResponsiveContainer>
                <LineChart data={latencyHistory}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                  <XAxis dataKey="time" stroke="var(--text-muted)" fontSize={12} />
                  <YAxis
                    stroke="var(--text-muted)" fontSize={12}
                    label={{ value: 'ms', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)' }}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(223,40%,12%)', borderColor: 'var(--border-color)', borderRadius: '8px' }}
                    labelStyle={{ color: 'var(--text-primary)' }}
                  />
                  <Legend verticalAlign="top" height={36} iconType="circle" />
                  <Line type="monotone" dataKey="latency" stroke="var(--primary)" strokeWidth={2} activeDot={{ r: 8 }} name="Latency (ms)" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-center text-muted" style={{ padding: '80px 0', fontSize: '0.9rem' }}>
                Waiting for telemetry data.
              </div>
            )}
          </div>
        </div>

        {/* Device Status Breakdown */}
        <div className="glass-panel">
          <div className="chart-title">
            <span>Status Distribution</span>
            <Database size={16} color="var(--primary)" />
          </div>
          <div style={{ width: '100%', height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            {statusData.length > 0 ? (
              <ResponsiveContainer width="100%" height="80%">
                <PieChart>
                  <Pie data={statusData} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(223,40%,12%)', borderColor: 'var(--border-color)', borderRadius: '8px' }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="text-muted">No device status data</div>
            )}
            <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap', justifyContent: 'center', fontSize: '0.8rem', marginTop: '10px' }}>
              {statusData.map((item, index) => (
                <div key={index} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: item.color }} />
                  <span>{item.name}: {item.value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Regional Network Segments – only shown when real data exists */}
      {regions.length > 0 && (
        <>
          <div className="tickets-section-title" style={{ marginTop: '30px', marginBottom: '15px' }}>
            <Activity size={18} color="var(--primary)" />
            <span>Regional Network Segments</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '25px' }}>
            {regions.map((r) => {
              const isCritical = r.health_status === 'Critical';
              const isWarning  = r.health_status === 'Warning';
              const isUnknown  = r.health_status === 'Unknown';
              let healthColor = 'var(--color-up)';
              if (isCritical) healthColor = 'var(--color-down)';
              else if (isWarning) healthColor = 'var(--color-degraded)';
              else if (isUnknown) healthColor = 'var(--text-muted)';

              return (
                <div key={r.region} className="glass-panel" style={{ borderLeft: `4px solid ${healthColor}` }}>
                  <div className="flex-between" style={{ marginBottom: '12px' }}>
                    <h4 style={{ fontSize: '1.15rem', fontWeight: 700 }}>{r.region} Segment</h4>
                    <span className="status-badge" style={{
                      backgroundColor: isCritical ? 'rgba(239,68,68,0.1)' : isWarning ? 'rgba(245,158,11,0.1)' : isUnknown ? 'rgba(100,116,139,0.1)' : 'rgba(16,185,129,0.1)',
                      color: healthColor,
                      borderColor: isCritical ? 'rgba(239,68,68,0.2)' : isWarning ? 'rgba(245,158,11,0.2)' : isUnknown ? 'rgba(100,116,139,0.2)' : 'rgba(16,185,129,0.2)',
                    }}>
                      {r.health_status}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.85rem', marginBottom: '12px' }}>
                    <div>
                      <span className="text-muted">Devices: </span>
                      <span className="mono" style={{ fontWeight: 600 }}>{r.online_count} / {r.devices_count} Online</span>
                    </div>
                    <div>
                      <span className="text-muted">Avg Latency: </span>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {r.avg_latency > 0 ? `${r.avg_latency} ms` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">Max Latency: </span>
                      <span className="mono" style={{ fontWeight: 600 }}>
                        {r.max_latency > 0 ? `${r.max_latency} ms` : '—'}
                      </span>
                    </div>
                    <div>
                      <span className="text-muted">Backup Failures: </span>
                      <span className="mono" style={{ color: r.backup_failures_24h > 0 ? 'var(--color-down)' : 'var(--text-muted)' }}>
                        {r.backup_failures_24h}
                      </span>
                    </div>
                  </div>

                  {/* Sparkline – only rendered when real latency data exists */}
                  {r.sparkline && r.sparkline.length > 1 ? (
                    <div style={{ marginTop: '10px', height: '40px', display: 'flex', alignItems: 'flex-end', gap: '4px' }}>
                      {r.sparkline.map((val: number, idx: number) => {
                        const maxVal = Math.max(...r.sparkline, 1);
                        const pct = (val / maxVal) * 100;
                        return (
                          <div
                            key={idx}
                            style={{
                              flex: 1,
                              height: `${Math.max(10, pct)}%`,
                              backgroundColor: isCritical ? 'rgba(239,68,68,0.45)' : 'rgba(0,229,255,0.45)',
                              borderRadius: '2px',
                            }}
                            title={`Latency: ${val}ms`}
                          />
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ marginTop: '10px', fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                      Waiting for telemetry data.
                    </div>
                  )}

                  {/* Outages – only shown when real DOWN status recorded */}
                  {r.offline_devices && r.offline_devices.length > 0 && r.health_status !== 'Unknown' && (
                    <div style={{ marginTop: '12px', fontSize: '0.75rem', padding: '6px 10px', background: 'rgba(239,68,68,0.05)', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.15)', color: 'var(--color-down)' }}>
                      <strong>Outages:</strong> {r.offline_devices.join(', ')}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Recent Switch Incident Status */}
      <div className="tickets-section-title" style={{ marginTop: '30px', marginBottom: '15px' }}>
        <Activity size={18} color="var(--primary)" />
        <span>Recent Switch Incident Status</span>
      </div>

      <div className="glass-panel" style={{ padding: '20px', marginBottom: '25px' }}>
        {/* Toolbar */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '15px', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            {(['all', 'open', 'acknowledged', 'resolved', 'critical', 'major', 'medium', 'minor', 'warning'] as const).map(f => (
              <button
                key={f}
                className={`btn ${activeFilter === f ? 'btn-primary' : 'btn-secondary'}`}
                style={{ padding: '6px 12px', fontSize: '0.8rem', textTransform: 'capitalize' }}
                onClick={() => setActiveFilter(f)}
              >{f}</button>
            ))}
          </div>
          <div style={{ position: 'relative', minWidth: '260px' }}>
            <Search size={14} color="var(--text-muted)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              placeholder="Search Switch, IP, Ticket..."
              className="form-control"
              style={{ paddingLeft: '32px', height: '34px', fontSize: '0.8rem' }}
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
        </div>

        <div className="table-scroll-wrapper">
          <table className="custom-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <colgroup>
              <col style={{ width: '11%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '8%' }} />
              <col style={{ width: '9%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '10%' }} /><col style={{ width: '9%' }} />
              <col style={{ width: '9%' }} />
            </colgroup>
            <thead>
              <tr>
                <th onClick={() => handleSort('deviceName')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>Switch Name {renderSortIcon('deviceName')}</div>
                </th>
                <th>IP Address</th>
                <th onClick={() => handleSort('status')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>Status {renderSortIcon('status')}</div>
                </th>
                <th onClick={() => handleSort('severity')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>Severity {renderSortIcon('severity')}</div>
                </th>
                <th>Category</th>
                <th>Component</th>
                <th>Interface</th>
                <th>Mode</th>
                <th>Ticket ID</th>
                <th onClick={() => handleSort('detectedTime')} style={{ cursor: 'pointer', userSelect: 'none' }}>
                  <div style={{ display: 'flex', alignItems: 'center' }}>Detected {renderSortIcon('detectedTime')}</div>
                </th>
                <th>Current State</th>
              </tr>
            </thead>
            <tbody>
              {sortedTickets.length === 0 ? (
                <tr>
                  <td colSpan={11} className="text-center text-muted" style={{ padding: '32px 0', fontSize: '0.85rem' }}>
                    Waiting for telemetry data.
                  </td>
                </tr>
              ) : (
                Array.from({ length: Math.max(10, sortedTickets.length) }).map((_, index) => {
                  const ticket = sortedTickets[index];
                  if (ticket) {
                    const devState = getDeviceState(ticket.host);
                    const isCritical = ticket.severity === 'critical';
                    const isMedium   = ticket.severity === 'medium';
                    const isLow      = ticket.severity === 'low';
                    let severityLabel = 'Low';
                    let severityColor = 'var(--color-unknown)';
                    if (isCritical)            { severityLabel = 'Critical'; severityColor = 'var(--color-down)'; }
                    else if (isMedium)         { severityLabel = 'Medium';   severityColor = 'var(--color-degraded)'; }
                    else if (ticket.severity === 'high') { severityLabel = 'High'; severityColor = 'hsl(25,95%,50%)'; }
                    else if (isLow)            { severityLabel = 'Low';      severityColor = 'hsl(210,100%,55%)'; }
                    const statusClass = ticket.status === 'open' ? 'down' : ticket.status === 'acknowledged' ? 'degraded' : 'up';
                    return (
                      <tr key={ticket.id} style={{ height: '44px' }}>
                        <td className="mono truncate" title={ticket.deviceName}>{ticket.deviceName}</td>
                        <td className="mono">{ticket.host}</td>
                        <td><span className={`status-badge ${statusClass}`} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>{ticket.status}</span></td>
                        <td style={{ fontWeight: 600, color: severityColor }}>{severityLabel}</td>
                        <td style={{ fontSize: '0.75rem' }}>{(ticket as any).category || 'Connectivity'}</td>
                        <td className="mono truncate" style={{ fontSize: '0.75rem' }} title={(ticket as any).component_name || ''}>{(ticket as any).component_name || '—'}</td>
                        <td className="mono truncate" style={{ fontSize: '0.75rem' }} title={(ticket as any).interface_name || ''}>{(ticket as any).interface_name || '—'}</td>
                        <td style={{ fontSize: '0.75rem' }}>{(ticket as any).interface_mode || '—'}</td>
                        <td className="mono" style={{ fontSize: '0.78rem' }}>{ticket.id}</td>
                        <td className="mono" style={{ fontSize: '0.75rem' }}>{ticket.detectedTime.split(',')[1]?.trim() || ticket.detectedTime}</td>
                        <td><span className={`status-badge ${devState.toLowerCase()}`} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>{devState}</span></td>
                      </tr>
                    );
                  } else {
                    return (
                      <tr key={`empty-${index}`} className="empty-row" style={{ height: '44px' }}>
                        {Array.from({ length: 11 }).map((_, ci) => <td key={ci}>&nbsp;</td>)}
                      </tr>
                    );
                  }
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Resource Utilization */}
      <div className="glass-panel" style={{ marginBottom: '20px' }}>
        <div className="chart-title">
          <span>Active Resource Utilization (Top Devices)</span>
          <Activity size={16} color="var(--accent)" />
        </div>
        <div style={{ width: '100%', height: 280 }}>
          {utilizationData.length > 0 ? (
            <ResponsiveContainer>
              <BarChart data={utilizationData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                <XAxis dataKey="name" stroke="var(--text-muted)" fontSize={11} />
                <YAxis stroke="var(--text-muted)" fontSize={11} label={{ value: '%', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)' }} />
                <Tooltip contentStyle={{ backgroundColor: 'hsl(223,40%,12%)', borderColor: 'var(--border-color)', borderRadius: '8px' }} />
                <Legend verticalAlign="top" height={36} />
                <Bar dataKey="CPU"    fill="rgba(0,229,255,0.75)"  radius={[4,4,0,0]} />
                <Bar dataKey="Memory" fill="rgba(157,78,221,0.75)" radius={[4,4,0,0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-muted" style={{ padding: '40px 0' }}>
              No performance metrics polled yet. Metrics poll runs every 5 minutes (configurable).
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
