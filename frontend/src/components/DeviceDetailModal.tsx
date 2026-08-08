import { useEffect, useState } from 'react';
import { X, Clock, Cpu, HardDrive, ShieldCheck, Activity, RefreshCw } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

interface DeviceDetailModalProps {
  device: any;
  onClose: () => void;
}

export const DeviceDetailModal = ({ device, onClose }: DeviceDetailModalProps) => {
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch historical metrics for this device
    const fetchHistory = async () => {
      try {
        setLoading(true);
        const res = await fetch(`http://localhost:8000/api/devices/${device.host}/metrics`);
        if (res.ok) {
          const data = await res.json();
          // Format timestamps to local time string
          const formatted = data.map((item: any) => ({
            ...item,
            timeLabel: new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          }));
          setHistory(formatted);
        }
      } catch (e) {
        console.error("Failed to load metrics history:", e);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [device.host]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '800px' }}>
        
        {/* Modal Header */}
        <div className="modal-header">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {device.name}
              <span className={`status-badge ${device.status.toLowerCase()}`}>
                {device.status}
              </span>
            </h2>
            <p className="mono text-muted" style={{ fontSize: '0.85rem', marginTop: '4px' }}>
              Host IP: {device.host} | Type: {device.device_type}
            </p>
          </div>
          <button className="btn btn-secondary" style={{ padding: '6px', borderRadius: '50%' }} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="modal-body">
          {/* Quick Metrics Bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '15px', marginBottom: '25px' }}>
            <div className="glass-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Clock size={20} color="var(--primary)" />
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Ping Latency</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }} className="mono">
                  {device.status === 'DOWN' ? '—' : `${device.last_latency} ms`}
                </div>
              </div>
            </div>
            
            <div className="glass-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <Cpu size={20} color="var(--accent)" />
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CPU Utilization</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }} className="mono">
                  {device.status === 'DOWN' ? '—' : `${device.last_cpu}%`}
                </div>
              </div>
            </div>

            <div className="glass-panel" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <HardDrive size={20} color="var(--color-up)" />
              <div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Memory Load</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 700 }} className="mono">
                  {device.status === 'DOWN' ? '—' : `${device.last_memory}%`}
                </div>
              </div>
            </div>
          </div>

          {loading ? (
            <div className="text-center" style={{ padding: '60px 0' }}>
              <RefreshCw size={24} className="spin" style={{ color: 'var(--primary)' }} />
              <p style={{ marginTop: '10px', color: 'var(--text-muted)' }}>Loading time-series historical logs...</p>
            </div>
          ) : history.length > 0 ? (
            <div>
              {/* Latency History Chart */}
              <div style={{ marginBottom: '25px' }}>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Activity size={14} color="var(--primary)" /> Real-Time Latency Timeline (ms)
                </h3>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <LineChart data={history}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis dataKey="timeLabel" stroke="var(--text-muted)" fontSize={10} />
                      <YAxis stroke="var(--text-muted)" fontSize={10} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: 'hsl(223, 40%, 12%)', borderColor: 'var(--border-color)', borderRadius: '8px' }}
                      />
                      <Line type="monotone" dataKey="latency" name="Latency (ms)" stroke="var(--primary)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Resource History Chart */}
              <div>
                <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Cpu size={14} color="var(--accent)" /> System CPU & Memory Utilization (%)
                </h3>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <LineChart data={history}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis dataKey="timeLabel" stroke="var(--text-muted)" fontSize={10} />
                      <YAxis stroke="var(--text-muted)" fontSize={10} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: 'hsl(223, 40%, 12%)', borderColor: 'var(--border-color)', borderRadius: '8px' }}
                      />
                      <Legend verticalAlign="top" height={36} />
                      <Line type="monotone" dataKey="cpu" name="CPU Load (%)" stroke="var(--primary)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="memory" name="Memory Load (%)" stroke="var(--accent)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center text-muted" style={{ padding: '60px 0' }}>
              No historical data points found. Wait for the background worker to populate metrics (takes ~15-30s).
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="modal-footer">
          <div style={{ flexGrow: 1, textAlign: 'left', fontSize: '0.8rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <ShieldCheck size={14} color="var(--color-up)" />
            Last Seen: {device.last_seen ? new Date(device.last_seen).toLocaleString() : 'Never'}
          </div>
          <button className="btn btn-secondary" onClick={onClose}>Close Details</button>
        </div>

      </div>
    </div>
  );
};
