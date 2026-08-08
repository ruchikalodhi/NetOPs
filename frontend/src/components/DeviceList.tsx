import { useState } from 'react';
import { Search, RefreshCw, Eye, Trash2, Radar } from 'lucide-react';
import { DiscoveryModal } from './DiscoveryModal';

interface DeviceListProps {
  devices: any[];
  onTriggerBackup: (host: string) => void;
  onOpenDetails: (device: any) => void;
  onDeleteDevice: (id: number) => void;
  onRefresh?: () => void;
}

export const DeviceList = ({ 
  devices, 
  onTriggerBackup, 
  onOpenDetails, 
  onDeleteDevice,
  onRefresh,
}: DeviceListProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [discoveryDevice, setDiscoveryDevice] = useState<any>(null);

  // Filter devices based on search term and status filter
  const filteredDevices = devices.filter(device => {
    const matchesSearch = 
      device.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      device.host.includes(searchTerm);
      
    const matchesStatus = 
      statusFilter === 'ALL' || 
      device.status === statusFilter;

    return matchesSearch && matchesStatus;
  });

  return (
    <>
    {discoveryDevice && (
      <DiscoveryModal
        device={discoveryDevice}
        onClose={() => setDiscoveryDevice(null)}
        onImportComplete={() => { onRefresh?.(); }}
      />
    )}
    <div className="glass-panel">
      {/* Search and Filters Header */}
      <div className="flex-between" style={{ marginBottom: '20px', gap: '15px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flexGrow: 1, maxWidth: '400px' }}>
          <Search 
            size={18} 
            color="var(--text-muted)" 
            style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} 
          />
          <input
            type="text"
            className="form-control"
            placeholder="Search by Switch Name or IP Address..."
            style={{ paddingLeft: '40px' }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        <div className="flex-gap-10">
          <select 
            className="form-control" 
            style={{ width: '160px' }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">All Statuses</option>
            <option value="UP">Online (UP)</option>
            <option value="DEGRADED">Degraded</option>
            <option value="DOWN">Offline (DOWN)</option>
            <option value="UNKNOWN">Unknown</option>
          </select>
        </div>
      </div>

      {/* Devices Inventory Table */}
      <div className="table-container">
        {filteredDevices.length > 0 ? (
          <table className="custom-table">
            <thead>
              <tr>
                <th>Device Name</th>
                <th>IP Address</th>
                <th>Status</th>
                <th>Latency</th>
                <th>CPU Load</th>
                <th>Memory Load</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredDevices.map(device => {
                const isLocked = device.is_locked;
                
                return (
                  <tr key={device.id}>
                    <td>
                      <span style={{ fontWeight: 600 }}>{device.name}</span>
                    </td>
                    <td className="mono" style={{ color: 'var(--primary)' }}>
                      {device.host}
                    </td>
                    <td>
                      <div className="flex-gap-10">
                        <span className={`pulse-dot ${device.status.toLowerCase()}`} />
                        <span className={`status-badge ${device.status.toLowerCase()}`}>
                          {device.status}
                        </span>
                      </div>
                    </td>
                    <td className="mono">
                      {device.status === 'DOWN' || device.status === 'UNKNOWN' ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        `${device.last_latency} ms`
                      )}
                    </td>
                    <td className="mono">
                      {device.status === 'DOWN' || device.status === 'UNKNOWN' ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        `${device.last_cpu}%`
                      )}
                    </td>
                    <td className="mono">
                      {device.status === 'DOWN' || device.status === 'UNKNOWN' ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        `${device.last_memory}%`
                      )}
                    </td>
                    <td>
                      <div className="flex-gap-10" style={{ justifyContent: 'flex-end' }}>
                        {/* Details Button */}
                        <button 
                          className="btn btn-secondary" 
                          style={{ padding: '6px 12px', fontSize: '0.8rem' }}
                          title="View Performance History"
                          onClick={() => onOpenDetails(device)}
                        >
                          <Eye size={14} /> Details
                        </button>

                        {/* Discover Neighbors Button */}
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '0.8rem', borderColor: 'var(--primary)', color: 'var(--primary)' }}
                          title="Discover Neighboring Devices via LLDP/CDP"
                          onClick={() => setDiscoveryDevice(device)}
                        >
                          <Radar size={14} /> Discover
                        </button>

                        {/* Backup Button */}
                        <button 
                          className="btn btn-secondary" 
                          style={{ padding: '6px 12px', fontSize: '0.8rem', borderColor: isLocked ? 'var(--primary)' : 'var(--border-color)' }}
                          title="Backup Running Config"
                          onClick={() => onTriggerBackup(device.host)}
                          disabled={isLocked || device.status === 'DOWN'}
                        >
                          <RefreshCw size={14} className={isLocked ? 'spin' : ''} /> 
                          {isLocked ? 'Backing Up' : 'Backup'}
                        </button>

                        {/* Delete Button */}
                        <button 
                          className="btn btn-danger" 
                          style={{ padding: '6px 10px' }}
                          title="Delete Device"
                          onClick={() => {
                            if (window.confirm(`Are you sure you want to remove ${device.name} (${device.host})?`)) {
                              onDeleteDevice(device.id);
                            }
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-center text-muted" style={{ padding: '40px 0' }}>
            No devices match search filters.
          </div>
        )}
      </div>
    </div>
    </>
  );
};
