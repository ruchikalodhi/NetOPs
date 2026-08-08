import { useState, useEffect, useRef } from 'react';
import {
  Terminal,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Server,
  Wifi,
  WifiOff,
  Clock,
  Copy,
  Check,
  ShieldAlert,
  CornerDownLeft,
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

interface CommandResult {
  success: boolean;
  output: string;
  error: string | null;
  error_type: string | null;
  executed_at: string;
  device_name: string;
  device_host: string;
  command: string;
  prompt?: string;
}

// A single line rendered in the terminal scrollback buffer.
interface ConsoleLine {
  id: string;
  type: 'input' | 'output' | 'error' | 'system';
  text: string;
  prompt?: string;
}

// One entry in the audit log shown beneath the terminal.
interface AuditEntry {
  id: string;
  command: string;
  device_name: string;
  device_host: string;
  success: boolean;
  blocked: boolean;
  error_type: string | null;
  executed_at: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:8000';

const MAX_SCROLLBACK = 500;
const MAX_HISTORY = 50;
const MAX_AUDIT_LOG = 100;

// Client-side mirror of the backend blacklist. The backend is the source of
// truth — this is only used to give the operator instant feedback before the
// request round-trip.
const BLOCKED_PATTERNS: RegExp[] = [
  /^reload\b/,
  /^write\s+erase\b/,
  /^erase\b/,
  /^format\b/,
  /^delete\b/,
  /^clear\b/,
  /^copy\b/,
  /^configure\b/,
  /^conf\s*t/,
  /^no\s+/,
  /^shutdown\b/,
  /^crypto\s+key\s+zeroize/,
  /^write\b/,
  /^debug\b/,
  /^undebug\b/,
  /^request\s+system\s+reboot/,
  /^request\s+system\s+halt/,
  /^request\s+vmhost\s+reboot/,
  /^monitor\s+/,
  /^test\s+/,
  /^reset\b/,
  /^restart\b/,
  /^kill\b/,
];

// Curated set of the most commonly used read-only / operational commands for
// network administrators, grouped by category for the quick-pick dropdown.
// All entries here are safe, non-destructive "show"/"display"/"ping"-style
// operational commands — none of these trip the blacklist.
const COMMON_COMMAND_GROUPS: { label: string; commands: string[] }[] = [
  {
    label: 'Interfaces & Status',
    commands: [
      'show ip interface brief',
      'show interfaces',
      'show interfaces status',
      'show interfaces description',
      'show interfaces counters errors',
      'show running-config interface',
    ],
  },
  {
    label: 'System Info',
    commands: [
      'show version',
      'show running-config',
      'show startup-config',
      'show inventory',
      'show environment',
      'show processes cpu',
      'show memory statistics',
      'show clock',
    ],
  },
  {
    label: 'Layer 2 / Switching',
    commands: [
      'show vlan brief',
      'show mac address-table',
      'show spanning-tree',
      'show spanning-tree summary',
      'show etherchannel summary',
      'show interfaces trunk',
    ],
  },
  {
    label: 'Layer 3 / Routing',
    commands: [
      'show ip route',
      'show ip protocols',
      'show ip ospf neighbor',
      'show ip bgp summary',
      'show arp',
      'show ip nat translations',
    ],
  },
  {
    label: 'Neighbors & Topology',
    commands: [
      'show cdp neighbors',
      'show cdp neighbors detail',
      'show lldp neighbors',
      'show lldp neighbors detail',
    ],
  },
  {
    label: 'Connectivity Tests',
    commands: [
      'ping',
      'traceroute',
      'show ip ssh',
      'show users',
      'show sessions',
    ],
  },
  {
    label: 'Logging & Diagnostics',
    commands: [
      'show logging',
      'show log',
      'terminal length 0',
      'show tech-support',
    ],
  },
];

function isBlockedClientSide(command: string): boolean {
  const c = command.trim().toLowerCase();
  if (!c) return false;
  return BLOCKED_PATTERNS.some(p => p.test(c));
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function devicePrompt(device: Device | null, fromResult?: string): string {
  if (fromResult) return fromResult;
  if (!device) return 'device>';
  // Best-effort fallback prompt before the first command returns a real one.
  const short = device.name.split(/\s+/)[0].toLowerCase();
  return `${short}#`;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function SSHStatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
    ONLINE:     { color: 'var(--color-up)',        label: 'SSH Online',  icon: <Wifi size={12} /> },
    OFFLINE:    { color: 'var(--color-down)',      label: 'SSH Offline', icon: <WifiOff size={12} /> },
    AUTH_FAILED:{ color: 'var(--color-degraded)',  label: 'Auth Failed', icon: <AlertCircle size={12} /> },
    UNKNOWN:    { color: 'var(--color-unknown)',   label: 'SSH Unknown', icon: <Clock size={12} /> },
  };
  const cfg = map[status] ?? map['UNKNOWN'];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 8px',
        borderRadius: '6px',
        fontSize: '0.72rem',
        fontWeight: 700,
        letterSpacing: '0.4px',
        textTransform: 'uppercase',
        color: cfg.color,
        background: `color-mix(in srgb, ${cfg.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${cfg.color} 30%, transparent)`,
      }}
    >
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

function ErrorTypeLabel({ type }: { type: string }) {
  const labels: Record<string, string> = {
    AUTH_FAILED:    '🔐 Authentication Failed',
    TIMEOUT:        '⏱ Connection Timed Out',
    UNREACHABLE:    '📡 Device Unreachable',
    NO_CREDENTIALS: '🔑 No Credentials Configured',
    BLOCKED:        '🚫 Command Not Permitted',
    GENERIC:        '⚠️ SSH Error',
  };
  return <>{labels[type] ?? '⚠️ Error'}</>;
}

// ─── Main component ──────────────────────────────────────────────────────────

export function CommandTerminal({ devices }: { devices: Device[] }) {
  const [selectedDeviceId, setSelectedDeviceId] = useState<number | null>(null);
  const [isRunning, setIsRunning]               = useState(false);
  const [lines, setLines]                       = useState<ConsoleLine[]>([]);
  const [inputValue, setInputValue]             = useState('');
  const [commandHistory, setCommandHistory]     = useState<string[]>([]);
  const [historyIndex, setHistoryIndex]         = useState<number | null>(null);
  const [auditLog, setAuditLog]                 = useState<AuditEntry[]>([]);
  const [currentPrompt, setCurrentPrompt]       = useState<string>('');
  const [copied, setCopied]                     = useState(false);

  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLInputElement>(null);

  // Auto-select first device with SSH enabled
  useEffect(() => {
    if (devices.length > 0 && selectedDeviceId === null) {
      const sshDevice = devices.find(d => d.ssh_enabled) ?? devices[0];
      setSelectedDeviceId(sshDevice.id);
    }
  }, [devices, selectedDeviceId]);

  const selectedDevice = devices.find(d => d.id === selectedDeviceId) ?? null;

  // Reset prompt + scrollback when the target device changes
  useEffect(() => {
    setCurrentPrompt(devicePrompt(selectedDevice));
    setLines(prev => {
      if (!selectedDevice) return prev;
      return [
        ...prev,
        {
          id: makeId(),
          type: 'system',
          text: `// Connected target set to ${selectedDevice.name} (${selectedDevice.host}). Session credentials are resolved server-side.`,
        },
      ].slice(-MAX_SCROLLBACK);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDeviceId]);

  // Auto-scroll terminal output to bottom whenever new lines are appended
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, isRunning]);

  const appendLines = (newLines: ConsoleLine[]) => {
    setLines(prev => [...prev, ...newLines].slice(-MAX_SCROLLBACK));
  };

  const pushAudit = (entry: AuditEntry) => {
    setAuditLog(prev => [entry, ...prev].slice(0, MAX_AUDIT_LOG));
  };

  const handleRunCommand = async () => {
    const command = inputValue.trim();
    if (!command || isRunning) return;
    if (!selectedDeviceId || !selectedDevice) {
      appendLines([{ id: makeId(), type: 'error', text: '// No target device selected.' }]);
      return;
    }

    const promptForInput = currentPrompt || devicePrompt(selectedDevice);

    // Echo the command into the console immediately
    appendLines([{ id: makeId(), type: 'input', text: command, prompt: promptForInput }]);

    // Update local command history (most recent last; navigated in reverse)
    setCommandHistory(prev => {
      const next = prev[prev.length - 1] === command ? prev : [...prev, command];
      return next.slice(-MAX_HISTORY);
    });
    setHistoryIndex(null);
    setInputValue('');

    // Client-side blacklist pre-check for instant feedback
    if (isBlockedClientSide(command)) {
      const blockedText =
        `Command '${command}' is blocked. Destructive or configuration-altering ` +
        `commands are not permitted from the operational terminal.`;
      appendLines([{ id: makeId(), type: 'error', text: `🚫 ${blockedText}` }]);
      pushAudit({
        id: makeId(),
        command,
        device_name: selectedDevice.name,
        device_host: selectedDevice.host,
        success: false,
        blocked: true,
        error_type: 'BLOCKED',
        executed_at: new Date().toISOString(),
      });
      return;
    }

    setIsRunning(true);

    try {
      const res = await fetch(`${API_BASE}/api/ssh/terminal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: selectedDeviceId, command }),
      });

      let data: CommandResult;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown server error' }));
        data = {
          success: false,
          output: '',
          error: err.detail ?? 'Request failed',
          error_type: 'GENERIC',
          executed_at: new Date().toISOString(),
          device_name: selectedDevice.name,
          device_host: selectedDevice.host,
          command,
        };
      } else {
        data = await res.json();
      }

      if (data.success) {
        appendLines([
          { id: makeId(), type: 'output', text: data.output || '(empty response)' },
        ]);
        if (data.prompt) setCurrentPrompt(data.prompt);
      } else {
        const header = data.error_type ? `${errorTypeText(data.error_type)}\n\n` : '';
        appendLines([
          { id: makeId(), type: 'error', text: `${header}${data.error ?? 'Command failed.'}` },
        ]);
      }

      pushAudit({
        id: makeId(),
        command,
        device_name: data.device_name || selectedDevice.name,
        device_host: data.device_host || selectedDevice.host,
        success: data.success,
        blocked: data.error_type === 'BLOCKED',
        error_type: data.error_type,
        executed_at: data.executed_at,
      });
    } catch (e: any) {
      const msg = e?.message ?? 'Network error – is the backend running?';
      appendLines([{ id: makeId(), type: 'error', text: `⚠️ SSH Error\n\n${msg}` }]);
      pushAudit({
        id: makeId(),
        command,
        device_name: selectedDevice.name,
        device_host: selectedDevice.host,
        success: false,
        blocked: false,
        error_type: 'GENERIC',
        executed_at: new Date().toISOString(),
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRunCommand();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length === 0) return;
      setHistoryIndex(prev => {
        const next = prev === null ? commandHistory.length - 1 : Math.max(0, prev - 1);
        setInputValue(commandHistory[next] ?? '');
        return next;
      });
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (commandHistory.length === 0 || historyIndex === null) return;
      setHistoryIndex(prev => {
        if (prev === null) return null;
        const next = prev + 1;
        if (next >= commandHistory.length) {
          setInputValue('');
          return null;
        }
        setInputValue(commandHistory[next] ?? '');
        return next;
      });
      return;
    }
  };

  const handleCopy = () => {
    const text = lines
      .map(l => (l.type === 'input' ? `${l.prompt ?? ''} ${l.text}` : l.text))
      .join('\n');
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const errorTypeText = (type: string): string => {
    const labels: Record<string, string> = {
      AUTH_FAILED:    '🔐 Authentication Failed',
      TIMEOUT:        '⏱ Connection Timed Out',
      UNREACHABLE:    '📡 Device Unreachable',
      NO_CREDENTIALS: '🔑 No Credentials Configured',
      BLOCKED:        '🚫 Command Not Permitted',
      GENERIC:        '⚠️ SSH Error',
    };
    return labels[type] ?? '⚠️ Error';
  };

  const liveBlocked = isBlockedClientSide(inputValue);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Header Banner ─────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <Terminal size={20} color="var(--primary)" />
          <h2 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0 }}>SSH Command Terminal</h2>
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>
          Type any operational command and press Enter to run it over SSH on the selected device.
        </p>
      </div>

      {/* ── Control Panel ─────────────────────────────────────────────── */}
      <div className="glass-panel">
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
              disabled={isRunning}
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
            <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <SSHStatusBadge status={selectedDevice.ssh_status ?? 'UNKNOWN'} />
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
                {selectedDevice.device_type}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Terminal Output ────────────────────────────────────────────── */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden' }}>

        {/* Terminal header bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 20px',
            borderBottom: '1px solid var(--border-color)',
            background: 'rgba(0,0,0,0.2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {/* Traffic-light dots */}
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57', display: 'inline-block' }} />
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e', display: 'inline-block' }} />
            <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840', display: 'inline-block' }} />
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '8px', fontFamily: 'JetBrains Mono, monospace' }}>
              {selectedDevice ? `${selectedDevice.host} — ${currentPrompt || devicePrompt(selectedDevice)}` : 'SSH Terminal Console'}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {isRunning && (
              <span style={{ fontSize: '0.75rem', color: 'var(--primary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Loader2 size={12} className="spin" /> Executing…
              </span>
            )}
            {lines.length > 0 && (
              <button
                className="btn btn-secondary"
                onClick={handleCopy}
                style={{ padding: '5px 10px', fontSize: '0.75rem' }}
              >
                {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy</>}
              </button>
            )}
          </div>
        </div>

        {/* Output area */}
        <div
          ref={outputRef}
          style={{
            margin: 0,
            padding: '20px',
            minHeight: '300px',
            maxHeight: '440px',
            overflowY: 'auto',
            background: 'rgba(5, 7, 12, 0.6)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '0.82rem',
            lineHeight: '1.6',
            color: 'var(--text-primary)',
          }}
        >
          {lines.length === 0 && !isRunning && (
            <div style={{ color: 'var(--text-muted)', opacity: 0.5, whiteSpace: 'pre-wrap' }}>
              {'// Select a target device, type a command, and press Enter to run it.\n'}
              {'// Use ↑ / ↓ to recall previous commands. Output will appear here.'}
            </div>
          )}

          {lines.map(line => {
            if (line.type === 'input') {
              return (
                <div key={line.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-primary)' }}>
                  <span style={{ color: 'var(--primary)', fontWeight: 700 }}>{line.prompt} </span>
                  {line.text}
                </div>
              );
            }
            if (line.type === 'output') {
              return (
                <div key={line.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#a8ff78', marginBottom: '6px' }}>
                  {line.text}
                </div>
              );
            }
            if (line.type === 'error') {
              return (
                <div key={line.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--color-down)', marginBottom: '6px' }}>
                  {'❌ '}{line.text}
                </div>
              );
            }
            return (
              <div key={line.id} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--text-muted)', opacity: 0.7, marginBottom: '6px' }}>
                {line.text}
              </div>
            );
          })}

          {isRunning && (
            <div style={{ color: 'var(--primary)', opacity: 0.8, whiteSpace: 'pre-wrap' }}>
              {`▶  Running command on ${selectedDevice?.host}…`}
              <span style={{ display: 'inline-block', animation: 'blink 1s step-end infinite', marginLeft: '4px' }}>_</span>
            </div>
          )}
        </div>

        {/* Command input bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 16px',
            borderTop: '1px solid var(--border-color)',
            background: 'rgba(0,0,0,0.25)',
          }}
        >
          <span style={{ color: 'var(--primary)', fontWeight: 700, fontFamily: 'JetBrains Mono, monospace', fontSize: '0.88rem', whiteSpace: 'nowrap' }}>
            {currentPrompt || devicePrompt(selectedDevice)}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isRunning || !selectedDeviceId}
            placeholder="Type a command and press Enter…"
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: liveBlocked ? 'var(--color-down)' : 'var(--text-primary)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: '0.88rem',
              padding: '6px 0',
            }}
          />
          {liveBlocked && inputValue.trim() && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', color: 'var(--color-down)', whiteSpace: 'nowrap' }}>
              <ShieldAlert size={13} /> Blocked
            </span>
          )}

          {/* Quick-pick dropdown of common network admin commands */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <select
              value=""
              onChange={e => {
                const cmd = e.target.value;
                if (!cmd) return;
                setInputValue(cmd);
                setHistoryIndex(null);
                inputRef.current?.focus();
              }}
              disabled={isRunning || !selectedDeviceId}
              title="Insert a common command"
              style={{
                appearance: 'none',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                color: 'var(--text-muted)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '0.78rem',
                padding: '6px 28px 6px 10px',
                cursor: 'pointer',
                maxWidth: '180px',
              }}
            >
              <option value="">Quick commands…</option>
              {COMMON_COMMAND_GROUPS.map(group => (
                <optgroup key={group.label} label={group.label}>
                  {group.commands.map(cmd => (
                    <option key={cmd} value={cmd}>{cmd}</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <ChevronDown
              size={13}
              style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-muted)' }}
            />
          </div>

          <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
            <CornerDownLeft size={13} /> Run
          </span>
        </div>
      </div>

      {/* ── Command History ───────────────────────────────────────────── */}
      {commandHistory.length > 0 && (
        <div className="glass-panel">
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Command History
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {[...commandHistory].slice().reverse().slice(0, 20).map((cmd, i) => (
              <button
                key={`${cmd}-${i}`}
                onClick={() => { setInputValue(cmd); setHistoryIndex(null); inputRef.current?.focus(); }}
                className="btn btn-secondary"
                style={{
                  padding: '5px 10px',
                  fontSize: '0.78rem',
                  fontFamily: 'JetBrains Mono, monospace',
                  cursor: 'pointer',
                }}
                title="Click to reuse this command"
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Execution Audit Log ───────────────────────────────────────── */}
      {auditLog.length > 0 && (
        <div className="glass-panel">
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '14px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Execution Audit Log
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {auditLog.map(entry => (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  background: 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                  {entry.blocked ? (
                    <ShieldAlert size={14} color="var(--color-degraded)" />
                  ) : entry.success ? (
                    <CheckCircle2 size={14} color="var(--color-up)" />
                  ) : (
                    <AlertCircle size={14} color="var(--color-down)" />
                  )}
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.82rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '380px' }}>
                    {entry.command}
                  </span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    → {entry.device_name}
                  </span>
                  {entry.error_type && (
                    <span style={{ fontSize: '0.72rem', color: entry.blocked ? 'var(--color-degraded)' : 'var(--color-down)', whiteSpace: 'nowrap' }}>
                      {entry.error_type}
                    </span>
                  )}
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: '12px' }}>
                  {new Date(entry.executed_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
