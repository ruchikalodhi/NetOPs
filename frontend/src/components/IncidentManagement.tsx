import React, { useState, useMemo } from 'react';
import { Clock, ShieldAlert, CheckCircle2, Search, Thermometer, Wind, Zap, Network, Cpu } from 'lucide-react';

interface Ticket {
  id: string;
  deviceName: string;
  host: string;
  detectedTime: string;
  severity: 'critical' | 'major' | 'high' | 'medium' | 'minor' | 'warning' | 'low';
  status: 'open' | 'acknowledged' | 'resolved';
  resolvedTime?: string;
  lastUpdated?: string;
  // Extended fields
  category?: string;
  event_source?: string;
  component_type?: string;
  component_name?: string;
  hardware_sensor?: string;
  threshold_value?: number;
  actual_value?: number;
  interface_name?: string;
  interface_description?: string;
  interface_mode?: string;
  interface_admin_state?: string;
  interface_oper_state?: string;
  native_vlan?: string;
  allowed_vlans?: string;
  port_channel?: string;
}

interface IncidentManagementProps {
  tickets: Ticket[];
  onAcknowledgeTicket: (id: string) => void;
  onResolveTicket: (id: string) => void;
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Environmental: <Wind size={14} />,
  Interface:     <Network size={14} />,
  Hardware:      <Cpu size={14} />,
  Power:         <Zap size={14} />,
  Thermal:       <Thermometer size={14} />,
  Security:      <ShieldAlert size={14} />,
  Connectivity:  <Network size={14} />,
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'var(--color-down)',
  major:    'hsl(25,95%,50%)',
  high:     'hsl(25,95%,50%)',
  medium:   'var(--color-degraded)',
  minor:    'hsl(210,100%,55%)',
  warning:  'var(--color-degraded)',
  low:      'var(--text-muted)',
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span style={{
      fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px',
      borderRadius: '4px', textTransform: 'uppercase',
      color: SEVERITY_COLOR[severity] || 'var(--text-muted)',
      background: `${SEVERITY_COLOR[severity] || 'var(--text-muted)'}18`,
      border: `1px solid ${SEVERITY_COLOR[severity] || 'var(--text-muted)'}30`,
    }}>
      {severity}
    </span>
  );
}

function CategoryBadge({ category }: { category: string }) {
  const colors: Record<string, string> = {
    Environmental: 'hsl(145,70%,40%)',
    Interface:     'hsl(210,100%,55%)',
    Hardware:      'hsl(270,70%,60%)',
    Power:         'hsl(35,90%,50%)',
    Thermal:       'hsl(355,90%,55%)',
    Security:      'hsl(300,70%,55%)',
    Connectivity:  'var(--primary)',
  };
  const color = colors[category] || 'var(--primary)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      fontSize: '0.7rem', fontWeight: 600, padding: '2px 7px',
      borderRadius: '4px', color,
      background: `${color}18`, border: `1px solid ${color}30`,
    }}>
      {CATEGORY_ICONS[category] || null}
      {category || 'Connectivity'}
    </span>
  );
}

function InterfaceDetail({ ticket }: { ticket: Ticket }) {
  if (!ticket.interface_name) return null;
  return (
    <div style={{
      marginTop: '8px', padding: '8px 10px',
      background: 'rgba(0,229,255,0.04)', borderRadius: '6px',
      border: '1px solid rgba(0,229,255,0.12)', fontSize: '0.75rem',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '4px', color: 'var(--primary)' }}>
        Interface Detail
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
        {ticket.interface_name && <div><span style={{ color: 'var(--text-muted)' }}>Interface: </span>{ticket.interface_name}</div>}
        {ticket.interface_mode && <div><span style={{ color: 'var(--text-muted)' }}>Mode: </span>{ticket.interface_mode}</div>}
        {ticket.interface_admin_state && <div><span style={{ color: 'var(--text-muted)' }}>Admin: </span>{ticket.interface_admin_state}</div>}
        {ticket.interface_oper_state && <div><span style={{ color: 'var(--text-muted)' }}>Oper: </span>{ticket.interface_oper_state}</div>}
        {ticket.interface_description && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--text-muted)' }}>Desc: </span>{ticket.interface_description}</div>}
        {ticket.allowed_vlans && <div style={{ gridColumn: '1/-1' }}><span style={{ color: 'var(--text-muted)' }}>VLANs: </span>{ticket.allowed_vlans}</div>}
        {ticket.native_vlan && <div><span style={{ color: 'var(--text-muted)' }}>Native VLAN: </span>{ticket.native_vlan}</div>}
        {ticket.port_channel && <div><span style={{ color: 'var(--text-muted)' }}>Port-Channel: </span>{ticket.port_channel}</div>}
      </div>
    </div>
  );
}

function HardwareDetail({ ticket }: { ticket: Ticket }) {
  if (!ticket.component_name || ticket.interface_name) return null;
  return (
    <div style={{
      marginTop: '8px', padding: '8px 10px',
      background: 'rgba(157,78,221,0.04)', borderRadius: '6px',
      border: '1px solid rgba(157,78,221,0.15)', fontSize: '0.75rem',
    }}>
      <div style={{ fontWeight: 700, marginBottom: '4px', color: 'hsl(270,70%,65%)' }}>
        Hardware Detail
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
        {ticket.component_type && <div><span style={{ color: 'var(--text-muted)' }}>Type: </span>{ticket.component_type}</div>}
        {ticket.component_name && <div><span style={{ color: 'var(--text-muted)' }}>Component: </span>{ticket.component_name}</div>}
        {ticket.hardware_sensor && <div><span style={{ color: 'var(--text-muted)' }}>Sensor: </span>{ticket.hardware_sensor}</div>}
        {ticket.actual_value != null && <div><span style={{ color: 'var(--text-muted)' }}>Value: </span>{ticket.actual_value}°C</div>}
        {ticket.threshold_value != null && <div><span style={{ color: 'var(--text-muted)' }}>Threshold: </span>{ticket.threshold_value}°C</div>}
      </div>
    </div>
  );
}

const CATEGORIES = ['all', 'Connectivity', 'Interface', 'Environmental', 'Power', 'Thermal', 'Hardware', 'Security'] as const;

export const IncidentManagement: React.FC<IncidentManagementProps> = ({
  tickets,
  onAcknowledgeTicket,
  onResolveTicket,
}) => {
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'acknowledged' | 'resolved'>('open');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filteredTickets = useMemo(() => {
    return tickets.filter(t => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (categoryFilter !== 'all' && (t.category || 'Connectivity') !== categoryFilter) return false;
      const q = searchTerm.toLowerCase();
      return (
        t.deviceName.toLowerCase().includes(q) ||
        t.host.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q) ||
        (t.interface_name || '').toLowerCase().includes(q) ||
        (t.component_name || '').toLowerCase().includes(q)
      );
    });
  }, [tickets, statusFilter, categoryFilter, searchTerm]);

  const openCount     = tickets.filter(t => t.status === 'open').length;
  const ackCount      = tickets.filter(t => t.status === 'acknowledged').length;
  const resolvedCount = tickets.filter(t => t.status === 'resolved').length;

  // Category counts for filter pills
  const catCounts = useMemo(() => {
    const m: Record<string, number> = {};
    tickets.filter(t => t.status !== 'resolved').forEach(t => {
      const c = t.category || 'Connectivity';
      m[c] = (m[c] || 0) + 1;
    });
    return m;
  }, [tickets]);

  return (
    <div>
      {/* Status + Search toolbar */}
      <div className="glass-panel" style={{ marginBottom: '18px', display: 'flex', flexWrap: 'wrap', gap: '16px', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {(['open', 'acknowledged', 'resolved', 'all'] as const).map(f => (
            <button key={f} className={`btn ${statusFilter === f ? 'btn-primary' : 'btn-secondary'}`}
              style={{ padding: '8px 14px', fontSize: '0.82rem' }}
              onClick={() => setStatusFilter(f)}>
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f === 'open' ? ` (${openCount})` : f === 'acknowledged' ? ` (${ackCount})` : f === 'resolved' ? ` (${resolvedCount})` : ` (${tickets.length})`}
            </button>
          ))}
        </div>
        <div style={{ position: 'relative', minWidth: '280px' }}>
          <Search size={16} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
          <input type="text" placeholder="Search device, IP, ticket, interface..." className="form-control"
            style={{ paddingLeft: '36px', height: '38px', fontSize: '0.85rem' }}
            value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
        </div>
      </div>

      {/* Category filter pills */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '18px' }}>
        {CATEGORIES.map(c => {
          const count = c === 'all' ? tickets.filter(t => t.status !== 'resolved').length : (catCounts[c] || 0);
          const active = categoryFilter === c;
          return (
            <button key={c}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '5px',
                padding: '5px 11px', borderRadius: '20px', fontSize: '0.78rem',
                border: `1px solid ${active ? 'var(--primary)' : 'var(--border-color)'}`,
                background: active ? 'rgba(0,229,255,0.12)' : 'transparent',
                color: active ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
              }}
              onClick={() => setCategoryFilter(c)}>
              {c !== 'all' && CATEGORY_ICONS[c]}
              {c} {count > 0 && `(${count})`}
            </button>
          );
        })}
      </div>

      {/* Ticket cards */}
      {filteredTickets.length > 0 ? (
        <div className="tickets-grid">
          {filteredTickets.map(ticket => {
            const isCritical  = ticket.severity === 'critical';
            const isExpanded  = expandedId === ticket.id;
            const category    = ticket.category || 'Connectivity';

            return (
              <div key={ticket.id}
                className={`glass-panel ticket-card ${ticket.status === 'resolved' ? 'resolved' : 'pulse-glow'}`}
                style={ticket.status === 'resolved' ? { borderLeftColor: 'var(--color-up)' } :
                       isCritical ? { borderLeftColor: 'var(--color-down)' } : {}}>

                {/* Header */}
                <div className="flex-between">
                  <span className="ticket-id-badge">{ticket.id}</span>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <CategoryBadge category={category} />
                    <span className={`ticket-status-pill ${ticket.status}`}>{ticket.status}</span>
                  </div>
                </div>

                {/* Device info */}
                <div className="ticket-device-info">
                  <div className="ticket-device-name">{ticket.deviceName}</div>
                  <div className="ticket-device-host">{ticket.host}</div>
                </div>

                {/* Meta */}
                <div className="ticket-meta">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <ShieldAlert size={14} color={SEVERITY_COLOR[ticket.severity] || 'var(--text-muted)'} />
                    <span>Severity: </span><SeverityBadge severity={ticket.severity} />
                  </div>
                  {ticket.component_name && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Component: <span style={{ color: 'var(--text-primary)' }}>{ticket.component_name}</span>
                    </div>
                  )}
                  {ticket.interface_name && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                      Interface: <span style={{ color: 'var(--primary)', fontFamily: 'monospace' }}>{ticket.interface_name}</span>
                      {ticket.interface_mode && <span> ({ticket.interface_mode})</span>}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <Clock size={14} />
                    <span>Detected: <span className="mono">{ticket.detectedTime}</span></span>
                  </div>
                  {ticket.status === 'resolved' && ticket.resolvedTime && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <CheckCircle2 size={14} color="var(--color-up)" />
                      <span>Resolved: <span className="mono" style={{ color: 'var(--color-up)' }}>{ticket.resolvedTime}</span></span>
                    </div>
                  )}
                  {ticket.event_source && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      Source: {ticket.event_source}
                    </div>
                  )}
                </div>

                {/* Expandable detail */}
                <button
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.75rem', padding: '4px 0', textAlign: 'left' }}
                  onClick={() => setExpandedId(isExpanded ? null : ticket.id)}>
                  {isExpanded ? '▲ Hide detail' : '▼ Show detail'}
                </button>

                {isExpanded && (
                  <div>
                    <InterfaceDetail ticket={ticket} />
                    <HardwareDetail ticket={ticket} />
                    {ticket.details && (
                      <div style={{
                        marginTop: '8px', padding: '8px 10px', borderRadius: '6px',
                        background: 'rgba(100,116,139,0.06)', border: '1px solid var(--border-color)',
                        fontSize: '0.72rem', whiteSpace: 'pre-wrap', color: 'var(--text-muted)',
                      }}>
                        {ticket.details}
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="ticket-actions">
                  {ticket.status === 'open' && (
                    <button className="btn btn-secondary"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', flex: 1 }}
                      onClick={() => onAcknowledgeTicket(ticket.id)}>
                      Acknowledge
                    </button>
                  )}
                  {ticket.status !== 'resolved' && (
                    <button className="btn btn-primary"
                      style={{ padding: '6px 12px', fontSize: '0.75rem', flex: 1 }}
                      onClick={() => onResolveTicket(ticket.id)}>
                      Resolve Ticket
                    </button>
                  )}
                  {ticket.status === 'resolved' && (
                    <div className="text-center text-up" style={{ width: '100%', fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-up)' }}>
                      Ticket Resolved
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="glass-panel text-center text-muted" style={{ padding: '40px' }}>
          <CheckCircle2 size={32} color="var(--color-up)" style={{ marginBottom: '12px' }} />
          <div>No tickets matching selected filters.</div>
        </div>
      )}
    </div>
  );
};
