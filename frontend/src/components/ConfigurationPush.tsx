import { useState, useEffect } from 'react';
import {
  Settings,
  Send,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  Server,
  ShieldAlert,
  FileCode,
  ClipboardCopy,
  Clock,
  RotateCcw,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

interface Device {
  id: number;
  name: string;
  host: string;
  device_type: string;
  status: string;
  ssh_status: string;
  ssh_enabled: boolean;
  region: string;
}

interface ConfigResult {
  success: boolean;
  output: string;
  error: string | null;
  error_type: string | null;
  executed_at: string;
  device_name: string;
  device_host: string;
  commands_count: number;
}

interface DeploymentRecord {
  result: ConfigResult;
  commandsSent: string[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:8000';

const CONFIG_TEMPLATES: Record<string, string> = {
  'Interface Description': `interface GigabitEthernet0/1
 description Updated via NetOps Dashboard
 exit`,
  'VLAN Creation': `vlan 100
 name CORP_DATA
 exit`,
  'NTP Server': `ntp server 10.0.0.1
ntp server 10.0.0.2`,
  'Logging Host': `logging host 10.0.0.50
logging trap informational`,
  'Spanning Tree': `spanning-tree mode rapid-pvst
spanning-tree portfast default`,
};

// ─── Sub-components ──────────────────────────────────────────────────────────

function WarningBanner() {
  return (
    <div
      style={{
        display: 'flex',
        gap: '14px',
        padding: '16px 20px',
        borderRadius: '10px',
        background: 'rgba(245, 158, 11, 0.07)',
        border: '1px solid rgba(245, 158, 11, 0.28)',
        marginBottom: '4px',
      }}
    >
      <ShieldAlert size={20} color="var(--color-degraded)" style={{ flexShrink: 0, marginTop: '2px' }} />
      <div>
        <div style={{ fontWeight: 700, color: 'var(--color-degraded)', fontSize: '0.9rem', marginBottom: '4px' }}>
          LIVE CONFIGURATION DEPLOYMENT WARNING
        </div>
        <div style={{ fontSize: '0.83rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
          Commands entered here will be applied directly to the device's running configuration over SSH.
          Incorrect commands may cause connectivity loss or service interruption.
          Always verify commands in a test environment first.
          All deployments are logged in the Audit Trail.
        </div>
      </div>
    </div>
  );
}

function ErrorTypeLabel({ type }: { type: string }) {
  const labels: Record<string, string> = {
    AUTH_FAILED:    '🔐 Authentication Failed',
    TIMEOUT:        '⏱ Connection Timed Out',
    UNREACHABLE:    '📡 Device Unreachable',
    NO_CREDENTIALS: '🔑 No Credentials Configured',
    BLOCKED:        '🚫 Command Blocked by Policy',
    EMPTY_INPUT:    '📋 No Commands Provided',
    GENERIC:        '⚠️ SSH Error',
  };
  return <>{labels[type] ?? '⚠️ Error'}</>;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function ConfigurationPush({ devices }: { devices: Device[] }) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [configText, setConfigText]             = useState<string>('');
  const [isDeploying, setIsDeploying]           = useState(false);
  const [result, setResult]                     = useState<ConfigResult | null>(null);
  const [confirmed, setConfirmed]               = useState(false);
  const [deployHistory, setDeployHistory]       = useState<DeploymentRecord[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');

  // Auto-select first device
  useEffect(() => {
    if (devices.length > 0 && selectedDeviceId === null) {
      const sshDevice = devices.find(d => d.ssh_enabled) ?? devices[0];
      setSelectedDeviceId(sshDevice.id);
    }
  }, [devices, selectedDeviceId]);

  // Reset confirmation whenever device or config changes
  useEffect(() => {
    setConfirmed(false);
    setResult(null);
  }, [selectedDeviceId, configText]);

  const selectedDevice = devices.find(d => d.id === selectedDeviceId) ?? null;

  const commandLines = configText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const handleTemplateSelect = (templateKey: string) => {
    if (!templateKey) return;
    setConfigText(CONFIG_TEMPLATES[templateKey] ?? '');
    setSelectedTemplate(templateKey);
  };

  const handleDeploy = async () => {
    if (!selectedDeviceId || commandLines.length === 0 || isDeploying || !confirmed) return;

    setIsDeploying(true);
    setResult(null);

    try {
      const res = await fetch(`${API_BASE}/api/ssh/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: selectedDeviceId, commands: commandLines }),
      });

      const data: ConfigResult = await res.json();
      setResult(data);

      if (data.success) {
        setDeployHistory(prev => [{ result: data, commandsSent: commandLines }, ...prev].slice(0, 10));
        setConfigText('');
        setSelectedTemplate('');
        setConfirmed(false);
      }
    } catch (e: any) {
      setResult({
        success: false,
        output: '',
        error: e?.message ?? 'Network error – is the backend running?',
        error_type: 'GENERIC',
        executed_at: new Date().toISOString(),
        device_name: selectedDevice?.name ?? '',
        device_host: selectedDevice?.host ?? '',
        commands_count: commandLines.length,
      });
    } finally {
      setIsDeploying(false);
    }
  };

  const handleClear = () => {
    setConfigText('');
    setSelectedTemplate('');
    setResult(null);
    setConfirmed(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Header Banner ─────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <Settings size={20} color="var(--accent)" />
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>Push Configuration</h2>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          Deploy configuration changes directly to managed devices via SSH.
          Enter global-mode commands line-by-line. Enable confirmation before deployment.
        </p>
      </div>

      {/* ── Warning ───────────────────────────────────────────────────── */}
      <WarningBanner />

      {/* ── Control Panel ─────────────────────────────────────────────── */}
      <div className="glass-panel">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>

          {/* Device selector */}
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Server size={13} />
              TARGET DEVICE
            </label>
            <div style={{ position: 'relative' }}>
              <select
                className="form-control"
                value={selectedDeviceId ?? ''}
                onChange={e => setSelectedDeviceId(Number(e.target.value))}
                disabled={isDeploying}
                style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer' }}
              >
                <option value="" disabled>Select a device…</option>
                {devices.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name} — {d.host} ({d.region})
                  </option>
                ))}
              </select>
              <ChevronDown
                size={16}
                style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }}
              />
            </div>
            {selectedDevice && (
              <div style={{ marginTop: '8px', fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {selectedDevice.device_type} · SSH: <span style={{ color: selectedDevice.ssh_status === 'ONLINE' ? 'var(--color-up)' : 'var(--color-degraded)' }}>{selectedDevice.ssh_status}</span>
              </div>
            )}
          </div>

          {/* Template selector */}
          <div className="form-group" style={{ margin: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FileCode size={13} />
              LOAD TEMPLATE (OPTIONAL)
            </label>
            <div style={{ position: 'relative' }}>
              <select
                className="form-control"
                value={selectedTemplate}
                onChange={e => handleTemplateSelect(e.target.value)}
                disabled={isDeploying}
                style={{ appearance: 'none', paddingRight: '36px', cursor: 'pointer' }}
              >
                <option value="">— Choose a config template —</option>
                {Object.keys(CONFIG_TEMPLATES).map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
              <ChevronDown
                size={16}
                style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }}
              />
            </div>
            <div style={{ marginTop: '8px', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Templates pre-fill the editor. Edit before deploying.
            </div>
          </div>
        </div>
      </div>

      {/* ── Config Editor ──────────────────────────────────────────────── */}
      <div className="glass-panel">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Configuration Commands
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                fontSize: '0.75rem',
                color: commandLines.length > 0 ? 'var(--primary)' : 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              {commandLines.length} {commandLines.length === 1 ? 'command' : 'commands'}
            </span>
            <button
              className="btn btn-secondary"
              onClick={handleClear}
              disabled={isDeploying}
              style={{ padding: '5px 10px', fontSize: '0.75rem' }}
            >
              <RotateCcw size={12} /> Clear
            </button>
          </div>
        </div>

        <textarea
          className="form-control"
          rows={12}
          placeholder={`Enter global configuration commands, one per line.\nExample:\n  interface GigabitEthernet0/1\n   description UPLINK-TO-CORE\n   exit`}
          value={configText}
          onChange={e => setConfigText(e.target.value)}
          disabled={isDeploying}
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.85rem',
            lineHeight: 1.7,
            resize: 'vertical',
            minHeight: '220px',
          }}
        />

        {/* Command preview chips */}
        {commandLines.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '12px' }}>
            {commandLines.slice(0, 8).map((cmd, i) => (
              <span
                key={i}
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '0.73rem',
                  padding: '3px 8px',
                  borderRadius: '5px',
                  background: 'rgba(157, 78, 221, 0.1)',
                  border: '1px solid rgba(157, 78, 221, 0.25)',
                  color: 'var(--accent)',
                }}
              >
                {cmd.length > 38 ? cmd.slice(0, 36) + '…' : cmd}
              </span>
            ))}
            {commandLines.length > 8 && (
              <span style={{ fontSize: '0.73rem', color: 'var(--text-muted)', padding: '3px 8px' }}>
                +{commandLines.length - 8} more
              </span>
            )}
          </div>
        )}

        {/* Confirmation checkbox */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            marginTop: '20px',
            padding: '14px 16px',
            borderRadius: '8px',
            background: confirmed
              ? 'rgba(239, 68, 68, 0.06)'
              : 'rgba(255, 255, 255, 0.02)',
            border: `1px solid ${confirmed ? 'rgba(239,68,68,0.25)' : 'var(--border-color)'}`,
            cursor: 'pointer',
            userSelect: 'none',
          }}
          onClick={() => !isDeploying && setConfirmed(v => !v)}
        >
          <div
            style={{
              width: '18px',
              height: '18px',
              borderRadius: '4px',
              border: `2px solid ${confirmed ? 'var(--color-down)' : 'var(--border-color)'}`,
              background: confirmed ? 'rgba(239,68,68,0.2)' : 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              transition: 'all 0.2s',
            }}
          >
            {confirmed && <CheckCircle2 size={12} color="var(--color-down)" />}
          </div>
          <span style={{ fontSize: '0.85rem', color: confirmed ? 'var(--color-down)' : 'var(--text-muted)', fontWeight: confirmed ? 600 : 400 }}>
            I confirm I want to deploy these {commandLines.length} command{commandLines.length !== 1 ? 's' : ''} to{' '}
            <strong>{selectedDevice?.name ?? 'the selected device'}</strong> ({selectedDevice?.host}).
            This action cannot be automatically undone.
          </span>
        </div>

        {/* Deploy button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            className="btn"
            onClick={handleDeploy}
            disabled={isDeploying || !selectedDeviceId || commandLines.length === 0 || !confirmed}
            style={{
              padding: '12px 24px',
              fontSize: '0.95rem',
              background: confirmed && commandLines.length > 0
                ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                : 'var(--bg-card)',
              color: confirmed && commandLines.length > 0 ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${confirmed && commandLines.length > 0 ? 'rgba(239,68,68,0.5)' : 'var(--border-color)'}`,
              boxShadow: confirmed && commandLines.length > 0 ? '0 4px 15px rgba(239,68,68,0.2)' : 'none',
              transition: 'all 0.25s',
            }}
          >
            {isDeploying ? (
              <><Loader2 size={16} className="spin" /> Deploying to {selectedDevice?.name}…</>
            ) : (
              <><Send size={16} /> Deploy Configuration</>
            )}
          </button>
        </div>
      </div>

      {/* ── Result Panel ──────────────────────────────────────────────── */}
      {result && (
        <div
          className="glass-panel"
          style={{
            borderLeft: `4px solid ${result.success ? 'var(--color-up)' : 'var(--color-down)'}`,
            padding: '20px 24px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
            {result.success
              ? <CheckCircle2 size={18} color="var(--color-up)" />
              : <AlertCircle  size={18} color="var(--color-down)" />
            }
            <span style={{ fontWeight: 700, fontSize: '0.95rem', color: result.success ? 'var(--color-up)' : 'var(--color-down)' }}>
              {result.success
                ? `Configuration deployed successfully to ${result.device_name}`
                : <ErrorTypeLabel type={result.error_type ?? 'GENERIC'} />
              }
            </span>
            <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
              <Clock size={11} style={{ verticalAlign: 'middle' }} /> {new Date(result.executed_at).toLocaleString()}
            </span>
          </div>

          {result.error && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: '8px',
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.2)',
                fontSize: '0.85rem',
                color: 'var(--color-down)',
                fontFamily: 'JetBrains Mono, monospace',
                marginBottom: result.output ? '14px' : '0',
              }}
            >
              {result.error}
            </div>
          )}

          {result.output && (
            <pre
              style={{
                margin: 0,
                padding: '16px',
                borderRadius: '8px',
                background: 'rgba(5,7,12,0.5)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.8rem',
                lineHeight: 1.6,
                color: '#a8ff78',
                overflowX: 'auto',
                maxHeight: '300px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {result.output}
            </pre>
          )}

          {result.success && (
            <div style={{ marginTop: '12px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              ✅ {result.commands_count} commands applied · Changes logged to Audit Trail
            </div>
          )}
        </div>
      )}

      {/* ── Deployment History ────────────────────────────────────────── */}
      {deployHistory.length > 0 && (
        <div className="glass-panel">
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Deployment History (this session)
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {deployHistory.map((rec, i) => (
              <div
                key={i}
                style={{
                  padding: '12px 16px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  background: 'rgba(255,255,255,0.01)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={14} color="var(--color-up)" />
                    <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{rec.result.device_name}</span>
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{rec.result.device_host}</span>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {new Date(rec.result.executed_at).toLocaleTimeString()} · {rec.result.commands_count} commands
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px' }}>
                  {rec.commandsSent.slice(0, 5).map((cmd, j) => (
                    <span
                      key={j}
                      style={{
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: '0.71rem',
                        padding: '2px 7px',
                        borderRadius: '4px',
                        background: 'rgba(16,185,129,0.08)',
                        border: '1px solid rgba(16,185,129,0.2)',
                        color: 'var(--color-up)',
                      }}
                    >
                      {cmd.length > 40 ? cmd.slice(0, 38) + '…' : cmd}
                    </span>
                  ))}
                  {rec.commandsSent.length > 5 && (
                    <span style={{ fontSize: '0.71rem', color: 'var(--text-muted)', padding: '2px 7px' }}>
                      +{rec.commandsSent.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
