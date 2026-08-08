import { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Plus, Info, AlertTriangle, ShieldCheck } from 'lucide-react';

interface SettingsProps {
  onAddDevice: (deviceData: any) => Promise<boolean>;
}

export const Settings = ({ onAddDevice }: SettingsProps) => {
  // Device registration state
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [deviceType, setDeviceType] = useState('cisco_ios');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState('');
  const [isMonitored, setIsMonitored] = useState(true);


  const [testResult, setTestResult] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [testing, setTesting] = useState(false);

  // SNMP configuration (req 2)
  const [snmpVersion, setSnmpVersion] = useState<'v2c' | 'v3'>('v2c');
  const [snmpCommunity, setSnmpCommunity] = useState('public');
  const [snmpPort, setSnmpPort] = useState(161);
  const [snmpTimeout, setSnmpTimeout] = useState(5);
  const [snmpRetries, setSnmpRetries] = useState(1);
  const [snmpUsername, setSnmpUsername] = useState('');
  const [snmpAuthProtocol, setSnmpAuthProtocol] = useState('SHA');
  const [snmpAuthPassword, setSnmpAuthPassword] = useState('');
  const [snmpPrivProtocol, setSnmpPrivProtocol] = useState('AES');
  const [snmpPrivPassword, setSnmpPrivPassword] = useState('');



  // System settings state (loaded from DB)
  const [pingInterval, setPingInterval] = useState(15);
  const [metricsInterval, setMetricsInterval] = useState(300);
  const [backupInterval, setBackupInterval] = useState(300);
  const [environment, setEnvironment] = useState('demo');

  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [settingsMessage, setSettingsMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Fetch Settings on Mount
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const configEnvRes = await fetch('http://localhost:8000/api/config-env');
        if (configEnvRes.ok) {
          const configEnvData = await configEnvRes.json();
          setEnvironment(configEnvData.environment || 'demo');
        }

        const res = await fetch('http://localhost:8000/api/settings');
        if (res.ok) {
          const data = await res.json();
          setPingInterval(parseInt(data.ping_interval || '15'));
          setMetricsInterval(parseInt(data.metrics_interval || '300'));
          setBackupInterval(parseInt(data.backup_interval || '300'));
        }
      } catch (e) {
        console.error("Failed to load settings:", e);
      }
    };
    fetchSettings();
  }, []);

  // Save Settings Handler
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSettings(true);
    setSettingsMessage(null);
    try {
      const res = await fetch('http://localhost:8000/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ping_interval: pingInterval,
          metrics_interval: metricsInterval,
          backup_interval: backupInterval,
        })
      });
      if (res.ok) {
        setSettingsMessage({ text: 'System settings successfully updated. Intervals applied instantly.', type: 'success' });
      } else {
        setSettingsMessage({ text: 'Failed to update system settings.', type: 'error' });
      }
    } catch (e) {
      setSettingsMessage({ text: 'Connection failed. Verify the backend server is running.', type: 'error' });
    } finally {
      setSavingSettings(false);
    }
  };

  // Test Connection Handler (req 3.3)
  const handleTestConnection = async () => {
    if (!host || !username || !password) {
      setTestResult({ text: 'Enter IP Address, SSH Username and SSH Password to test.', type: 'error' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('http://localhost:8000/api/devices/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host,
          device_type: deviceType,
          username: username,
          password: password,
          secret: secret || password,
        })
      });
      const data = await res.json();
      setTestResult({ text: data.result || 'Unknown result', type: data.success ? 'success' : 'error' });
    } catch (e) {
      setTestResult({ text: 'Device Unreachable', type: 'error' });
    } finally {
      setTesting(false);
    }
  };

  // Add Device Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !host || !username || !password) {
      setMessage({ text: 'Please fill in all required fields.', type: 'error' });
      return;
    }

    const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipPattern.test(host)) {
      setMessage({ text: 'Please enter a valid IPv4 address.', type: 'error' });
      return;
    }



    setSubmitting(true);

    // SNMP mandatory-field validation (req 2.3)
    if (snmpVersion === 'v2c') {
      if (!snmpCommunity) {
        setMessage({ text: 'SNMP v2c requires a Community String.', type: 'error' });
        return;
      }
    } else {
      if (!snmpUsername || !snmpAuthProtocol || !snmpAuthPassword || !snmpPrivProtocol || !snmpPrivPassword) {
        setMessage({ text: 'SNMP v3 requires Username, Auth Protocol, Auth Password, Privacy Protocol and Privacy Password.', type: 'error' });
        return;
      }
    }
    const success = await onAddDevice({
      name,
      host,
      device_type: deviceType,
      username,
      password,
      secret: secret || password,
      is_monitored: isMonitored,
      region: 'Default',
      // SNMP configuration
      snmp_version: snmpVersion,
      snmp_port: snmpPort,
      snmp_timeout: snmpTimeout,
      snmp_retries: snmpRetries,
      snmp_community: snmpVersion === 'v2c' ? snmpCommunity : undefined,
      snmp_username: snmpVersion === 'v3' ? snmpUsername : undefined,
      snmp_auth_protocol: snmpVersion === 'v3' ? snmpAuthProtocol : undefined,
      snmp_auth_password: snmpVersion === 'v3' ? snmpAuthPassword : undefined,
      snmp_priv_protocol: snmpVersion === 'v3' ? snmpPrivProtocol : undefined,
      snmp_priv_password: snmpVersion === 'v3' ? snmpPrivPassword : undefined,
    });

    setSubmitting(false);

    if (success) {
      setMessage({ text: `Device ${name} (${host}) successfully added to inventory.`, type: 'success' });
      setName('');
      setHost('');
      setUsername('');
      setPassword('');
      setSecret('');

      setSnmpCommunity('public');
      setSnmpUsername('');
      setSnmpAuthPassword('');
      setSnmpPrivPassword('');

      setTestResult(null);
    } else {
      setMessage({ text: 'Failed to add device. Verify the host IP is unique.', type: 'error' });
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
      
      {/* Left Column: System Configurations Form */}
      <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <SettingsIcon size={20} color="var(--primary)" />
          <h3>System Settings & Profile</h3>
        </div>

        {settingsMessage && (
          <div 
            style={{ 
              padding: '12px', 
              borderRadius: '8px', 
              fontSize: '0.85rem',
              fontWeight: 500,
              backgroundColor: settingsMessage.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              color: settingsMessage.type === 'success' ? 'var(--color-up)' : 'var(--color-down)',
              border: `1px solid ${settingsMessage.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
            }}
          >
            {settingsMessage.text}
          </div>
        )}

        <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
          
          {/* Active Profile Status Badge */}
          <div 
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: '12px', 
              padding: '12px', 
              borderRadius: '8px', 
              backgroundColor: environment === 'demo' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
              color: environment === 'demo' ? '#3b82f6' : 'var(--color-up)',
              border: `1px solid ${environment === 'demo' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(16, 185, 129, 0.2)'}`
            }}
          >
            {environment === 'demo' ? (
              <>
                <Info size={20} style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700 }}>Demo Profile (Active)</div>
                  <div style={{ textTransform: 'none', fontSize: '0.75rem', marginTop: '2px', fontWeight: 400 }}>
                    Simulated monitoring. All devices will appear with mocked ping/SSH outputs.
                  </div>
                </div>
              </>
            ) : (
              <>
                <ShieldCheck size={20} style={{ flexShrink: 0 }} />
                <div>
                  <div style={{ fontWeight: 700 }}>Production Profile (Active)</div>
                  <div style={{ textTransform: 'none', fontSize: '0.75rem', marginTop: '2px', fontWeight: 400 }}>
                    Live network checks. Pings use real ICMP calls and backups trigger actual SSH handshakes to switches.
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="form-group">
            <label>Ping Monitoring Interval (seconds)</label>
            <input 
              type="number"
              className="form-control"
              value={pingInterval}
              onChange={(e) => setPingInterval(parseInt(e.target.value) || 5)}
              min="5"
              max="3600"
              required
            />
          </div>

          <div className="form-group">
            <label>CPU & RAM Performance Metric Polling (seconds)</label>
            <input 
              type="number"
              className="form-control"
              value={metricsInterval}
              onChange={(e) => setMetricsInterval(parseInt(e.target.value) || 10)}
              min="10"
              max="86400"
              required
            />
          </div>

          <div className="form-group">
            <label>Automatic Configuration Backup (seconds)</label>
            <input 
              type="number"
              className="form-control"
              value={backupInterval}
              onChange={(e) => setBackupInterval(parseInt(e.target.value) || 30)}
              min="30"
              max="604800"
              required
            />
          </div>

          <button 
            type="submit" 
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '10px' }}
            disabled={savingSettings}
          >
            {savingSettings ? 'Saving...' : 'Save Settings'}
          </button>
        </form>

        <div style={{ marginTop: '5px' }}>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: 0 }}>
            Modifying settings updates the database configuration table. The background workers read these intervals on every tick, adapting monitoring speeds without server downtime.
          </p>
        </div>
      </div>

      {/* Right Column: Register a New Device */}
      <div className="glass-panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
          <Plus size={20} color="var(--primary)" />
          <h3>Register New Device</h3>
        </div>

        {message && (
          <div 
            style={{ 
              padding: '12px', 
              borderRadius: '8px', 
              marginBottom: '16px',
              fontSize: '0.85rem',
              fontWeight: 500,
              backgroundColor: message.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              color: message.type === 'success' ? 'var(--color-up)' : 'var(--color-down)',
              border: `1px solid ${message.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
            }}
          >
            {message.text}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div className="form-group">
            <label>Device Name (Alias) *</label>
            <input 
              type="text" 
              className="form-control" 
              placeholder="e.g. Switch_3_1_Access"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>IP Address (IPv4) *</label>
            <input 
              type="text" 
              className="form-control" 
              placeholder="e.g. 10.81.3.1"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>Device Type / Protocol *</label>
            <select 
              className="form-control"
              value={deviceType}
              onChange={(e) => setDeviceType(e.target.value)}
            >
              <option value="cisco_ios">Cisco IOS Switch/Router (Netmiko SSH)</option>
              <option value="linux">Linux Server (SSH)</option>
              <option value="firewall">Firewall / Security Appliance</option>
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
            <div className="form-group">
              <label>SSH Username *</label>
              <input 
                type="text" 
                className="form-control" 
                placeholder="br_bina"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>

            <div className="form-group">
              <label>SSH Password *</label>
              <input 
                type="password" 
                className="form-control" 
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Enable Mode Secret (Defaults to SSH Password)</label>
            <input 
              type="password" 
              className="form-control" 
              placeholder="••••••••••••"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '5px 0' }}>
            <input 
              type="checkbox" 
              id="isMonitoredCheck"
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
              checked={isMonitored}
              onChange={(e) => setIsMonitored(e.target.checked)}
            />
            <label htmlFor="isMonitoredCheck" style={{ margin: 0, cursor: 'pointer', userSelect: 'none' }}>
              Include in background ping monitoring and statistics
            </label>
          </div>



          {testResult && (
            <div
              style={{
                padding: '10px',
                borderRadius: '8px',
                fontSize: '0.8rem',
                fontWeight: 500,
                backgroundColor: testResult.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: testResult.type === 'success' ? 'var(--color-up)' : 'var(--color-down)',
                border: `1px solid ${testResult.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`
              }}
            >
              {testResult.text}
            </div>
          )}
          <button 
            type="button"
            className="btn btn-secondary"
            onClick={handleTestConnection}
            disabled={testing}
          >
            {testing ? 'Testing...' : 'Test Connection'}
          </button>

          {/* --- SNMP Settings (req 2) --- */}
          <h4 style={{ margin: '10px 0 0', borderTop: '1px solid var(--border)', paddingTop: '15px' }}>SNMP Settings</h4>
          <div className="form-group">
            <label>SNMP Version *</label>
            <select
              className="form-control"
              value={snmpVersion}
              onChange={(e) => setSnmpVersion(e.target.value as 'v2c' | 'v3')}
            >
              <option value="v2c">SNMP v2c</option>
              <option value="v3">SNMP v3</option>
            </select>
          </div>

          {snmpVersion === 'v2c' ? (
            <>

            </>
          ) : (
            <>
              <div className="form-group">
                <label>SNMP Username *</label>
                <input type="text" className="form-control" value={snmpUsername} onChange={(e) => setSnmpUsername(e.target.value)} required={snmpVersion === 'v3'} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div className="form-group">
                  <label>Authentication Protocol *</label>
                  <select className="form-control" value={snmpAuthProtocol} onChange={(e) => setSnmpAuthProtocol(e.target.value)}>
                    <option value="MD5">MD5</option>
                    <option value="SHA">SHA</option>
                    <option value="SHA-256">SHA-256</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Authentication Password *</label>
                  <input type="password" className="form-control" value={snmpAuthPassword} onChange={(e) => setSnmpAuthPassword(e.target.value)} required={snmpVersion === 'v3'} />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div className="form-group">
                  <label>Privacy Protocol *</label>
                  <select className="form-control" value={snmpPrivProtocol} onChange={(e) => setSnmpPrivProtocol(e.target.value)}>
                    <option value="DES">DES</option>
                    <option value="AES">AES</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Privacy Password *</label>
                  <input type="password" className="form-control" value={snmpPrivPassword} onChange={(e) => setSnmpPrivPassword(e.target.value)} required={snmpVersion === 'v3'} />
                </div>
              </div>

            </>
          )}

          <button 
            type="submit" 
            className="btn btn-primary"
            style={{ width: '100%', marginTop: '10px' }}
            disabled={submitting}
          >
            {submitting ? 'Registering...' : 'Register Device'}
          </button>
        </form>
      </div>

    </div>
  );
};
