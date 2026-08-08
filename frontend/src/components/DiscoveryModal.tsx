import { useState, useEffect, useRef } from 'react';
import {
  X, Search, Radar, CheckSquare, Square, Download,
  RefreshCw, Wifi, AlertTriangle, CheckCircle2, ChevronDown
} from 'lucide-react';

interface Neighbor {
  hostname: string;
  ip: string;
  platform: string;
  description: string;
  local_port: string;
  remote_port: string;
  chassis_id: string;
  protocol: 'LLDP' | 'CDP' | 'LLDP+CDP';
  device_type_hint: string;
  status: 'New' | 'Already Registered';
  registered_id?: number | null;
  registered_name?: string | null;
}

interface DiscoveryModalProps {
  device: any;
  onClose: () => void;
  onImportComplete?: () => void;
}

type SortKey = 'hostname' | 'ip' | 'platform' | 'protocol' | 'device_type_hint' | 'local_port' | 'status';
type SortDir = 'asc' | 'desc';

const DEPTH_OPTIONS = [
  { value: 1, label: 'Depth 1 – Direct neighbors only' },
  { value: 2, label: 'Depth 2 – Neighbors of neighbors' },
  { value: 0, label: 'Unlimited – Entire reachable topology' },
];

const PROTOCOL_COLORS: Record<string, string> = {
  LLDP:      'var(--primary)',
  CDP:       '#f59e0b',
  'LLDP+CDP': '#10b981',
};

const TYPE_ICONS: Record<string, string> = {
  Router:              '🔀',
  Switch:              '🔲',
  Firewall:            '🛡️',
  'Access Point':      '📡',
  'Wireless Controller': '🌐',
  Server:              '🖥️',
  Unknown:             '❓',
};

export const DiscoveryModal = ({ device, onClose, onImportComplete }: DiscoveryModalProps) => {
  const [phase, setPhase] = useState<'configure' | 'discovering' | 'results' | 'importing'>('configure');
  const [depth, setDepth] = useState(1);
  const [taskId, setTaskId] = useState('');
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState('');
  const [neighbors, setNeighbors] = useState<Neighbor[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'New' | 'Already Registered'>('ALL');
  const [filterProto, setFilterProto] = useState<'ALL' | 'LLDP' | 'CDP' | 'LLDP+CDP'>('ALL');
  const [error, setError] = useState('');
  const [importResult, setImportResult] = useState<any>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── Discovery trigger ──────────────────────────────────────────────────────
  const startDiscovery = async () => {
    setError('');
    setPhase('discovering');
    setProgress(5);
    setProgressMsg('Initiating discovery...');

    try {
      const res = await fetch(`http://localhost:8000/api/devices/${device.id}/discover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ depth }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.detail || 'Discovery failed to start.');
        setPhase('configure');
        return;
      }
      setTaskId(data.task_id);
      startPolling(device.id, data.task_id);
    } catch (e) {
      setError('Could not reach the backend. Is it running?');
      setPhase('configure');
    }
  };

  const startPolling = (deviceId: number, tid: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `http://localhost:8000/api/devices/${deviceId}/discover/status/${tid}`
        );
        if (!res.ok) return;
        const data = await res.json();
        setProgress(data.progress || 0);
        setProgressMsg(data.message || '');

        if (data.status === 'complete') {
          clearInterval(pollRef.current!);
          setNeighbors(data.neighbors || []);
          setPhase('results');
          // Auto-select all "New" neighbors
          const newIdxs = (data.neighbors || [])
            .map((_: any, i: number) => i)
            .filter((i: number) => data.neighbors[i].status === 'New');
          setSelected(new Set(newIdxs));
        } else if (data.status === 'error') {
          clearInterval(pollRef.current!);
          setError(data.error || 'Discovery failed.');
          setPhase('configure');
        }
      } catch (_) {/* ignore poll errors */}
    }, 1500);
  };

  // ── Selection helpers ──────────────────────────────────────────────────────
  const filteredNeighbors = neighbors
    .filter(n => {
      const txt = search.toLowerCase();
      const matchSearch = !txt || 
        n.hostname.toLowerCase().includes(txt) ||
        n.ip.includes(txt) ||
        n.platform.toLowerCase().includes(txt) ||
        n.local_port.toLowerCase().includes(txt);
      const matchStatus = filterStatus === 'ALL' || n.status === filterStatus;
      const matchProto  = filterProto === 'ALL' || n.protocol === filterProto;
      return matchSearch && matchStatus && matchProto;
    })
    .sort((a, b) => {
      const av = (a as any)[sortKey] || '';
      const bv = (b as any)[sortKey] || '';
      return sortDir === 'asc'
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const toggleSelect = (idx: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const selectAllFiltered = () => {
    const newOnly = filteredNeighbors
      .map((n, i) => ({ n, realIdx: neighbors.indexOf(n) }))
      .filter(({ n }) => n.status === 'New')
      .map(({ realIdx }) => realIdx);
    setSelected(new Set(newOnly));
  };

  const deselectAll = () => setSelected(new Set());

  const selectedNeighbors = neighbors.filter((_, i) => selected.has(i));
  const newSelected = selectedNeighbors.filter(n => n.status === 'New');

  // ── Import ─────────────────────────────────────────────────────────────────
  const handleImport = async () => {
    if (newSelected.length === 0) return;
    setPhase('importing');

    try {
      const res = await fetch('http://localhost:8000/api/devices/import-discovered', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed_device_id: device.id,
          neighbors: newSelected,
        }),
      });
      const data = await res.json();
      setImportResult(data);
      if (onImportComplete) onImportComplete();
      setPhase('results'); // stay on results to show import outcome
    } catch (e) {
      setError('Import failed. Check backend logs.');
      setPhase('results');
    }
  };

  // ── Sort indicator ─────────────────────────────────────────────────────────
  const SortIndicator = ({ col }: { col: SortKey }) =>
    sortKey === col ? (
      <ChevronDown
        size={12}
        style={{ transform: sortDir === 'desc' ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
      />
    ) : null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          borderRadius: '16px', width: '95vw', maxWidth: '1100px',
          maxHeight: '90vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 25px 80px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px', borderBottom: '1px solid var(--border-color)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: 40, height: 40, borderRadius: '10px',
              background: 'rgba(99,102,241,0.15)', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <Radar size={20} color="var(--primary)" />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text-primary)' }}>
                Discover Neighbors
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {device.name} — {device.host} · SNMP {device.snmp_version?.toUpperCase()}
              </div>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ padding: '6px' }} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

          {/* ── Configure phase ── */}
          {phase === 'configure' && (
            <div style={{ maxWidth: 520, margin: '0 auto' }}>
              <p style={{ color: 'var(--text-muted)', marginBottom: 20, lineHeight: 1.6 }}>
                Runs LLDP and CDP SNMP queries against <strong style={{ color: 'var(--text-primary)' }}>{device.name}</strong> to
                discover neighboring devices. Results can then be imported into inventory.
              </p>

              <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>
                Discovery Depth
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24 }}>
                {DEPTH_OPTIONS.map(opt => (
                  <label
                    key={opt.value}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '12px 16px', borderRadius: '8px', cursor: 'pointer',
                      border: `1px solid ${depth === opt.value ? 'var(--primary)' : 'var(--border-color)'}`,
                      background: depth === opt.value ? 'rgba(99,102,241,0.1)' : 'var(--bg-primary)',
                      transition: 'all 0.15s',
                    }}
                  >
                    <input
                      type="radio" name="depth" value={opt.value}
                      checked={depth === opt.value}
                      onChange={() => setDepth(opt.value)}
                      style={{ accentColor: 'var(--primary)' }}
                    />
                    <span style={{ fontSize: '0.88rem', color: 'var(--text-primary)' }}>{opt.label}</span>
                  </label>
                ))}
              </div>

              {error && (
                <div style={{
                  padding: '12px 16px', borderRadius: '8px', marginBottom: 16,
                  background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
                  color: '#f87171', fontSize: '0.85rem',
                  display: 'flex', alignItems: 'center', gap: 8,
                }}>
                  <AlertTriangle size={14} /> {error}
                </div>
              )}

              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: '12px', fontWeight: 600, gap: 8 }}
                onClick={startDiscovery}
              >
                <Radar size={16} /> Start Discovery
              </button>
            </div>
          )}

          {/* ── Discovering phase ── */}
          {phase === 'discovering' && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <div style={{ marginBottom: 20 }}>
                <Radar size={48} color="var(--primary)" style={{ animation: 'spin 2s linear infinite' }} />
              </div>
              <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text-primary)', marginBottom: 8 }}>
                Discovering Neighbors...
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginBottom: 24 }}>
                {progressMsg || 'Querying LLDP and CDP MIBs via SNMP...'}
              </div>

              {/* Progress bar */}
              <div style={{
                maxWidth: 400, margin: '0 auto',
                background: 'var(--bg-primary)', borderRadius: 8, height: 8, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${progress}%`, height: '100%',
                  background: 'linear-gradient(90deg, var(--primary), #818cf8)',
                  borderRadius: 8, transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                {progress}%
              </div>
            </div>
          )}

          {/* ── Results phase ── */}
          {phase === 'results' && (
            <>
              {/* Summary bar */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { label: 'Total Found', value: neighbors.length, color: 'var(--primary)' },
                  { label: 'New', value: neighbors.filter(n => n.status === 'New').length, color: '#10b981' },
                  { label: 'Already Registered', value: neighbors.filter(n => n.status === 'Already Registered').length, color: 'var(--text-muted)' },
                  { label: 'Selected', value: newSelected.length, color: '#f59e0b' },
                ].map(stat => (
                  <div key={stat.label} style={{
                    flex: '1 1 100px', padding: '10px 14px', borderRadius: '8px',
                    background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
                    textAlign: 'center',
                  }}>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700, color: stat.color }}>{stat.value}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Import result banner */}
              {importResult && (
                <div style={{
                  padding: '12px 16px', borderRadius: '8px', marginBottom: 16,
                  background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <CheckCircle2 size={16} color="#10b981" />
                  <span style={{ fontSize: '0.88rem', color: '#6ee7b7' }}>
                    Import complete — {importResult.imported} imported, {importResult.skipped} skipped.
                    {importResult.errors?.length > 0 && ` ${importResult.errors.length} errors.`}
                  </span>
                </div>
              )}

              {/* Toolbar */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ position: 'relative', flexGrow: 1, minWidth: 200 }}>
                  <Search size={14} color="var(--text-muted)"
                    style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
                  <input
                    className="form-control" placeholder="Search hostname, IP, platform..."
                    style={{ paddingLeft: 32, fontSize: '0.85rem' }}
                    value={search} onChange={e => setSearch(e.target.value)}
                  />
                </div>
                <select className="form-control" style={{ width: 160, fontSize: '0.82rem' }}
                  value={filterStatus} onChange={e => setFilterStatus(e.target.value as any)}>
                  <option value="ALL">All Status</option>
                  <option value="New">New Only</option>
                  <option value="Already Registered">Registered</option>
                </select>
                <select className="form-control" style={{ width: 140, fontSize: '0.82rem' }}
                  value={filterProto} onChange={e => setFilterProto(e.target.value as any)}>
                  <option value="ALL">All Protocols</option>
                  <option value="LLDP">LLDP</option>
                  <option value="CDP">CDP</option>
                  <option value="LLDP+CDP">LLDP+CDP</option>
                </select>
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '6px 10px' }}
                  onClick={selectAllFiltered}>
                  <CheckSquare size={13} /> Select New
                </button>
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '6px 10px' }}
                  onClick={deselectAll}>
                  <Square size={13} /> Deselect All
                </button>
                <button className="btn btn-secondary" style={{ fontSize: '0.8rem', padding: '6px 10px' }}
                  onClick={() => { setPhase('configure'); setNeighbors([]); setImportResult(null); }}>
                  <RefreshCw size={13} /> Re-scan
                </button>
              </div>

              {/* Table */}
              {filteredNeighbors.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
                  {neighbors.length === 0
                    ? 'No neighbors found. The device may not support LLDP/CDP or SNMP credentials may need checking.'
                    : 'No neighbors match the current filters.'}
                </div>
              ) : (
                <div className="table-container">
                  <table className="custom-table" style={{ fontSize: '0.82rem' }}>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}></th>
                        {([
                          ['hostname', 'Hostname'],
                          ['ip', 'Management IP'],
                          ['device_type_hint', 'Type'],
                          ['platform', 'Platform/Model'],
                          ['protocol', 'Protocol'],
                          ['local_port', 'Local Port'],
                          ['remote_port', 'Remote Port'],
                          ['status', 'Status'],
                        ] as [SortKey, string][]).map(([key, label]) => (
                          <th key={key} onClick={() => toggleSort(key)}
                            style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>
                            {label} <SortIndicator col={key} />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredNeighbors.map(neighbor => {
                        const realIdx = neighbors.indexOf(neighbor);
                        const isSelected = selected.has(realIdx);
                        const isNew = neighbor.status === 'New';

                        return (
                          <tr
                            key={realIdx}
                            style={{
                              background: isSelected && isNew ? 'rgba(99,102,241,0.08)' : undefined,
                              opacity: neighbor.status === 'Already Registered' ? 0.65 : 1,
                              cursor: isNew ? 'pointer' : 'default',
                            }}
                            onClick={() => isNew && toggleSelect(realIdx)}
                          >
                            <td onClick={e => { e.stopPropagation(); isNew && toggleSelect(realIdx); }}>
                              {isNew ? (
                                isSelected
                                  ? <CheckSquare size={16} color="var(--primary)" />
                                  : <Square size={16} color="var(--text-muted)" />
                              ) : (
                                <CheckCircle2 size={16} color="var(--text-muted)" title="Already registered" />
                              )}
                            </td>
                            <td>
                              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                                {TYPE_ICONS[neighbor.device_type_hint] || '❓'} {neighbor.hostname || '—'}
                              </span>
                            </td>
                            <td className="mono" style={{ color: 'var(--primary)' }}>
                              {neighbor.ip || <span style={{ color: 'var(--text-muted)' }}>—</span>}
                            </td>
                            <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                              {neighbor.device_type_hint}
                            </td>
                            <td style={{ color: 'var(--text-muted)', fontSize: '0.78rem', maxWidth: 180 }}>
                              <span title={neighbor.platform}
                                style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {neighbor.platform || '—'}
                              </span>
                            </td>
                            <td>
                              <span style={{
                                display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                                fontSize: '0.72rem', fontWeight: 600,
                                color: PROTOCOL_COLORS[neighbor.protocol] || 'var(--text-muted)',
                                background: `${PROTOCOL_COLORS[neighbor.protocol]}22`,
                                border: `1px solid ${PROTOCOL_COLORS[neighbor.protocol]}44`,
                              }}>
                                {neighbor.protocol}
                              </span>
                            </td>
                            <td className="mono" style={{ fontSize: '0.78rem' }}>
                              {neighbor.local_port || '—'}
                            </td>
                            <td className="mono" style={{ fontSize: '0.78rem' }}>
                              {neighbor.remote_port || '—'}
                            </td>
                            <td>
                              {neighbor.status === 'New' ? (
                                <span className="status-badge" style={{
                                  background: 'rgba(16,185,129,0.15)', color: '#6ee7b7',
                                  border: '1px solid rgba(16,185,129,0.3)',
                                  padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 600,
                                }}>
                                  New
                                </span>
                              ) : (
                                <span className="status-badge" style={{
                                  background: 'rgba(99,102,241,0.12)', color: '#a5b4fc',
                                  border: '1px solid rgba(99,102,241,0.25)',
                                  padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem',
                                }}>
                                  ✓ Registered
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── Importing phase ── */}
          {phase === 'importing' && (
            <div style={{ textAlign: 'center', padding: '40px 0' }}>
              <RefreshCw size={40} color="var(--primary)" style={{ animation: 'spin 1s linear infinite' }} />
              <div style={{ marginTop: 16, color: 'var(--text-primary)', fontWeight: 600 }}>
                Importing {newSelected.length} device{newSelected.length !== 1 ? 's' : ''}...
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '16px 24px', borderTop: '1px solid var(--border-color)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {phase === 'results' && neighbors.length > 0 &&
              `${newSelected.length} device${newSelected.length !== 1 ? 's' : ''} selected for import`}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose} style={{ padding: '8px 20px' }}>
              Close
            </button>
            {phase === 'results' && newSelected.length > 0 && !importResult && (
              <button
                className="btn btn-primary"
                style={{ padding: '8px 20px', gap: 8, fontWeight: 600 }}
                onClick={handleImport}
              >
                <Download size={14} />
                Import {newSelected.length} Device{newSelected.length !== 1 ? 's' : ''}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
