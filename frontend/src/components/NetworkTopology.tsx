import { useState, useEffect, useRef, useCallback } from 'react';
import { RefreshCw, Search, ZoomIn, ZoomOut, Maximize2, GitBranch, Info } from 'lucide-react';

interface TopologyNode {
  id: string;
  label: string;
  host: string;
  status: string;
  device_type: string;
  region: string;
  cpu: number;
  memory: number;
  latency: number;
  // Layout
  x?: number;
  y?: number;
}

interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  local_interface: string;
  remote_interface: string;
  protocol: string;
  last_seen: string | null;
}

interface TopologyData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

const STATUS_COLORS: Record<string, string> = {
  UP:      '#10b981',
  DEGRADED: '#f59e0b',
  DOWN:    '#ef4444',
  UNKNOWN: '#6b7280',
};

const DEVICE_ICONS: Record<string, string> = {
  cisco_ios: '🔲',
  cisco_asa: '🛡️',
  cisco_wlc: '🌐',
  linux:     '🖥️',
};

const PROTOCOL_COLORS: Record<string, string> = {
  LLDP:      '#6366f1',
  CDP:       '#f59e0b',
  'LLDP+CDP': '#10b981',
};

// Simple force-directed layout
function applyForceLayout(nodes: TopologyNode[], edges: TopologyEdge[], width: number, height: number) {
  if (nodes.length === 0) return nodes;

  const positioned = nodes.map((n, i) => ({
    ...n,
    x: n.x ?? (100 + Math.random() * (width - 200)),
    y: n.y ?? (100 + Math.random() * (height - 200)),
    vx: 0,
    vy: 0,
  }));

  const edgeSet = new Set(edges.map(e => `${e.source}-${e.target}`));
  const nodeById: Record<string, typeof positioned[0]> = {};
  positioned.forEach(n => { nodeById[n.id] = n; });

  const REPULSION = 5000;
  const ATTRACTION = 0.05;
  const DAMPING = 0.85;
  const ITERATIONS = 100;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Repulsion between all pairs
    for (let i = 0; i < positioned.length; i++) {
      for (let j = i + 1; j < positioned.length; j++) {
        const a = positioned[i], b = positioned[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = REPULSION / (dist * dist);
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Attraction along edges
    edges.forEach(e => {
      const a = nodeById[e.source], b = nodeById[e.target];
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const fx = dx * ATTRACTION, fy = dy * ATTRACTION;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    });

    // Update positions
    positioned.forEach(n => {
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x = Math.max(50, Math.min(width - 50, n.x + n.vx));
      n.y = Math.max(50, Math.min(height - 50, n.y + n.vy));
    });
  }

  return positioned;
}

export const NetworkTopology = () => {
  const [topology, setTopology] = useState<TopologyData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selectedNode, setSelectedNode] = useState<TopologyNode | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [layoutNodes, setLayoutNodes] = useState<(TopologyNode & { x: number; y: number })[]>([]);

  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const WIDTH = 1000;
  const HEIGHT = 650;

  const fetchTopology = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('http://localhost:8000/api/topology');
      if (!res.ok) throw new Error('Failed to load topology');
      const data: TopologyData = await res.json();
      setTopology(data);

      // Apply force layout
      const laid = applyForceLayout(data.nodes, data.edges, WIDTH - 100, HEIGHT - 100) as any[];
      setLayoutNodes(laid);
    } catch (e) {
      setError('Could not load topology data. Run a discovery first to populate links.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTopology(); }, []);

  // Search highlight
  const highlightedIds = search
    ? new Set(layoutNodes
        .filter(n => n.label.toLowerCase().includes(search.toLowerCase()) || n.host.includes(search))
        .map(n => n.id))
    : null;

  // Pan handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.target === svgRef.current || (e.target as SVGElement).tagName === 'line') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
    }
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    if (isPanning) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
    }
  };
  const handleMouseUp = () => setIsPanning(false);

  const nodeById: Record<string, typeof layoutNodes[0]> = {};
  layoutNodes.forEach(n => { nodeById[n.id] = n; });

  const resetView = () => { setZoom(1); setPan({ x: 0, y: 0 }); };

  if (loading) {
    return (
      <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 400 }}>
        <div style={{ textAlign: 'center' }}>
          <RefreshCw size={32} color="var(--primary)" style={{ animation: 'spin 1s linear infinite' }} />
          <div style={{ marginTop: 12, color: 'var(--text-muted)' }}>Loading topology...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Toolbar */}
      <div className="glass-panel" style={{ padding: '14px 20px' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <GitBranch size={18} color="var(--primary)" />
            <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Network Topology</span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 6 }}>
              {topology.nodes.length} devices · {topology.edges.length} links
            </span>
          </div>

          <div style={{ flex: 1 }} />

          <div style={{ position: 'relative', width: 240 }}>
            <Search size={14} color="var(--text-muted)"
              style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
            <input className="form-control" placeholder="Search device..."
              style={{ paddingLeft: 32, fontSize: '0.83rem' }}
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary" style={{ padding: '6px 10px' }}
              onClick={() => setZoom(z => Math.min(z + 0.2, 3))}>
              <ZoomIn size={14} />
            </button>
            <button className="btn btn-secondary" style={{ padding: '6px 10px' }}
              onClick={() => setZoom(z => Math.max(z - 0.2, 0.3))}>
              <ZoomOut size={14} />
            </button>
            <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={resetView}>
              <Maximize2 size={14} />
            </button>
            <button className="btn btn-secondary" style={{ padding: '6px 10px' }} onClick={fetchTopology}>
              <RefreshCw size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Main topology canvas */}
      <div className="glass-panel" style={{ padding: 0, overflow: 'hidden', position: 'relative' }}>
        {error ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <GitBranch size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div>{error}</div>
            <div style={{ fontSize: '0.8rem', marginTop: 8 }}>
              Run a neighbor discovery from the Device Inventory page to populate topology links.
            </div>
          </div>
        ) : topology.nodes.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <GitBranch size={40} style={{ marginBottom: 12, opacity: 0.3 }} />
            <div>No topology data yet.</div>
            <div style={{ fontSize: '0.8rem', marginTop: 8 }}>Devices appear as nodes once discovery runs.</div>
          </div>
        ) : (
          <div ref={containerRef} style={{ width: '100%', overflow: 'hidden', cursor: isPanning ? 'grabbing' : 'grab' }}>
            <svg
              ref={svgRef}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              style={{ width: '100%', height: HEIGHT, display: 'block', background: 'var(--bg-primary)' }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <defs>
                <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                  <polygon points="0 0, 8 3, 0 6" fill="var(--border-color)" />
                </marker>
                <filter id="glow">
                  <feGaussianBlur stdDeviation="2" result="coloredBlur" />
                  <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
                </filter>
              </defs>

              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                {/* Edges */}
                {topology.edges.map(edge => {
                  const src = nodeById[edge.source];
                  const tgt = nodeById[edge.target];
                  if (!src || !tgt) return null;
                  const color = PROTOCOL_COLORS[edge.protocol] || '#6b7280';
                  const isHighlighted = !highlightedIds ||
                    highlightedIds.has(edge.source) || highlightedIds.has(edge.target);

                  return (
                    <g key={edge.id} opacity={isHighlighted ? 1 : 0.15}>
                      <line
                        x1={src.x} y1={src.y} x2={tgt.x} y2={tgt.y}
                        stroke={color} strokeWidth={1.5} strokeOpacity={0.6}
                        strokeDasharray={edge.protocol === 'CDP' ? '5,3' : undefined}
                      />
                      {/* Interface labels */}
                      {edge.local_interface && (
                        <text
                          x={(src.x + (src.x + tgt.x) / 2) / 2}
                          y={(src.y + (src.y + tgt.y) / 2) / 2 - 4}
                          fontSize={8} fill={color} opacity={0.8} textAnchor="middle"
                        >
                          {edge.local_interface}
                        </text>
                      )}
                    </g>
                  );
                })}

                {/* Nodes */}
                {layoutNodes.map(node => {
                  const isHighlighted = !highlightedIds || highlightedIds.has(node.id);
                  const isSelected = selectedNode?.id === node.id;
                  const statusColor = STATUS_COLORS[node.status] || '#6b7280';
                  const icon = DEVICE_ICONS[node.device_type] || '🔲';
                  const r = isSelected ? 26 : 22;

                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x}, ${node.y})`}
                      style={{ cursor: 'pointer' }}
                      opacity={isHighlighted ? 1 : 0.25}
                      onClick={() => setSelectedNode(selectedNode?.id === node.id ? null : node)}
                    >
                      {/* Pulse ring for UP devices */}
                      {node.status === 'UP' && (
                        <circle r={r + 6} fill="none" stroke={statusColor} strokeWidth={1} opacity={0.3}>
                          <animate attributeName="r" values={`${r + 2};${r + 10};${r + 2}`} dur="3s" repeatCount="indefinite" />
                          <animate attributeName="opacity" values="0.4;0;0.4" dur="3s" repeatCount="indefinite" />
                        </circle>
                      )}

                      {/* Node circle */}
                      <circle
                        r={r}
                        fill={isSelected ? 'var(--primary)' : 'var(--bg-secondary)'}
                        stroke={isSelected ? '#818cf8' : statusColor}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        filter={isSelected ? 'url(#glow)' : undefined}
                      />

                      {/* Status dot */}
                      <circle cx={r - 4} cy={-(r - 4)} r={4} fill={statusColor} />

                      {/* Label */}
                      <text
                        dy={r + 14}
                        textAnchor="middle"
                        fontSize={9}
                        fill={isHighlighted ? 'var(--text-primary)' : 'var(--text-muted)'}
                        fontWeight={isSelected ? 700 : 400}
                        style={{ pointerEvents: 'none' }}
                      >
                        {node.label.length > 14 ? node.label.slice(0, 12) + '…' : node.label}
                      </text>
                      <text
                        dy={r + 24}
                        textAnchor="middle"
                        fontSize={7}
                        fill="var(--text-muted)"
                        style={{ pointerEvents: 'none' }}
                      >
                        {node.host}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>
        )}

        {/* Legend */}
        <div style={{
          position: 'absolute', bottom: 12, left: 12,
          background: 'rgba(0,0,0,0.6)', borderRadius: 8,
          padding: '8px 12px', backdropFilter: 'blur(8px)',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: 2 }}>Legend</div>
          {Object.entries(STATUS_COLORS).map(([s, c]) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{s}</span>
            </div>
          ))}
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 4, paddingTop: 4 }}>
            {Object.entries(PROTOCOL_COLORS).map(([p, c]) => (
              <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                <div style={{ width: 16, height: 2, background: c }} />
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{p}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Zoom level badge */}
        <div style={{
          position: 'absolute', bottom: 12, right: 12,
          background: 'rgba(0,0,0,0.5)', borderRadius: 6,
          padding: '4px 8px', fontSize: '0.72rem', color: 'var(--text-muted)',
        }}>
          {Math.round(zoom * 100)}%
        </div>
      </div>

      {/* Selected node detail panel */}
      {selectedNode && (
        <div className="glass-panel" style={{ padding: '16px 20px' }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{
              width: 44, height: 44, borderRadius: '10px',
              background: `${STATUS_COLORS[selectedNode.status]}22`,
              border: `1px solid ${STATUS_COLORS[selectedNode.status]}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.4rem',
            }}>
              {DEVICE_ICONS[selectedNode.device_type] || '🔲'}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                {selectedNode.label}
              </div>
              <div className="mono" style={{ fontSize: '0.8rem', color: 'var(--primary)', marginTop: 2 }}>
                {selectedNode.host}
              </div>
              <div style={{ display: 'flex', gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
                {[
                  ['Status', selectedNode.status],
                  ['Region', selectedNode.region],
                  ['CPU', `${selectedNode.cpu}%`],
                  ['Memory', `${selectedNode.memory}%`],
                  ['Latency', `${selectedNode.latency} ms`],
                  ['Links', String(topology.edges.filter(e => e.source === selectedNode.id || e.target === selectedNode.id).length)],
                ].map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>{k}</div>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>{v}</div>
                  </div>
                ))}
              </div>
            </div>
            <button className="btn btn-secondary" style={{ padding: '5px 8px' }}
              onClick={() => setSelectedNode(null)}>
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
