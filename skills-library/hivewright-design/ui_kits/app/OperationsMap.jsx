// Molten honeycomb operations map — beveled hex nodes with glowing trails
const OperationsMap = () => {
  const nodes = [
    { id:'inbox',    x:90,  y:160, label:'Inbox',    state:'idle' },
    { id:'classify', x:210, y:80,  label:'Classify', state:'active' },
    { id:'enrich',   x:210, y:240, label:'Enrich',   state:'idle' },
    { id:'core',     x:360, y:160, label:'Hive',     state:'core' },
    { id:'crm',      x:510, y:80,  label:'CRM',      state:'active' },
    { id:'notify',   x:510, y:240, label:'Notify',   state:'idle' },
    { id:'reply',    x:630, y:160, label:'Reply',    state:'active' },
  ];
  const edges = [
    ['inbox','classify',true], ['inbox','enrich',false],
    ['classify','core',true], ['enrich','core',false],
    ['core','crm',true], ['core','notify',false],
    ['crm','reply',true], ['notify','reply',false],
  ];
  const get = id => nodes.find(n => n.id === id);

  // Hex polygon points generator (flat-top hex)
  const hexPoints = (cx, cy, r) => [
    [cx, cy - r],
    [cx + r*0.866, cy - r/2],
    [cx + r*0.866, cy + r/2],
    [cx, cy + r],
    [cx - r*0.866, cy + r/2],
    [cx - r*0.866, cy - r/2],
  ].map(p => p.join(',')).join(' ');

  return (
    <Card padded={false} accent style={{position:'relative'}}>
      <div style={{padding:'18px 20px 6px', display:'flex', alignItems:'center', justifyContent:'space-between', position:'relative', zIndex:2}}>
        <div>
          <Eyebrow>Operations map</Eyebrow>
          <div style={{font:'600 18px/24px Manrope', color:'#F2EBDD', marginTop:2}}>Acme Operations</div>
        </div>
        <div style={{display:'flex', gap:8}}>
          <Button variant="ghost" icon="filter" size="sm">Filter</Button>
          <Button variant="ghost" icon="sparkle" size="sm">Suggest</Button>
        </div>
      </div>
      <svg viewBox="0 0 720 320" style={{width:'100%', height:300, display:'block'}}>
        <defs>
          {/* Molten gradients shared by all hexes */}
          <linearGradient id="om-bevel" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#FFE89A"/><stop offset="50%" stopColor="#E59A1B"/><stop offset="100%" stopColor="#5C3206"/>
          </linearGradient>
          <linearGradient id="om-face-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFD56A"/><stop offset="22%" stopColor="#F0A416"/>
            <stop offset="50%" stopColor="#9A5400"/><stop offset="78%" stopColor="#F0A416"/>
            <stop offset="100%" stopColor="#FFD56A"/>
          </linearGradient>
          <linearGradient id="om-face-core" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#FFE89A"/><stop offset="30%" stopColor="#FFB836"/>
            <stop offset="55%" stopColor="#B86E08"/><stop offset="80%" stopColor="#FFB836"/>
            <stop offset="100%" stopColor="#FFE89A"/>
          </linearGradient>
          <linearGradient id="om-face-idle" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(229,154,27,0.18)"/>
            <stop offset="50%" stopColor="rgba(91,40,0,0.40)"/>
            <stop offset="100%" stopColor="rgba(229,154,27,0.18)"/>
          </linearGradient>
          <radialGradient id="om-glow" cx="0.5" cy="0.5" r="0.6">
            <stop offset="0%" stopColor="#FFB836" stopOpacity="0.45"/>
            <stop offset="60%" stopColor="#E59A1B" stopOpacity="0.08"/>
            <stop offset="100%" stopColor="#000000" stopOpacity="0"/>
          </radialGradient>
          <pattern id="om-hexbg" x="0" y="0" width="40" height="46" patternUnits="userSpaceOnUse">
            <path d="M10 0 L20 0 L25 8.6 L20 17.3 L10 17.3 L5 8.6 Z M30 23 L40 23 L45 31.6 L40 40.3 L30 40.3 L25 31.6 Z"
              stroke="rgba(255,184,54,0.045)" strokeWidth="0.6" fill="none"/>
          </pattern>
          <filter id="om-glow-filter" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3"/>
          </filter>
        </defs>

        <rect width="720" height="320" fill="url(#om-hexbg)"/>

        {/* Atmospheric glow behind core */}
        <circle cx="360" cy="160" r="120" fill="url(#om-glow)"/>

        {/* edges */}
        {edges.map(([f, t, active], i) => {
          const a = get(f), b = get(t);
          const path = `M${a.x},${a.y} C ${(a.x+b.x)/2},${a.y} ${(a.x+b.x)/2},${b.y} ${b.x},${b.y}`;
          return (
            <g key={i}>
              {active && <path d={path} fill="none" stroke="#FFB836" strokeWidth="3" strokeOpacity="0.18" filter="url(#om-glow-filter)"/>}
              <path d={path} fill="none"
                stroke={active ? '#FFB836' : 'rgba(184,137,90,0.22)'}
                strokeWidth={active ? 1.6 : 1.2}
                strokeDasharray={active ? '3 4' : '0'}
                style={active ? {animation:'hwFlow 1.4s linear infinite'} : {}}
              />
            </g>
          );
        })}

        {/* nodes */}
        {nodes.map(n => {
          const isCore = n.state === 'core';
          const isActive = n.state === 'active' || isCore;
          const r = isCore ? 38 : 26;
          const inner = r * 0.9;
          const faceFill = isCore ? 'url(#om-face-core)' : isActive ? 'url(#om-face-active)' : 'url(#om-face-idle)';
          const bevelFill = isActive ? 'url(#om-bevel)' : 'rgba(184,137,90,0.4)';
          return (
            <g key={n.id} style={isActive ? {filter:'drop-shadow(0 0 12px rgba(255,184,54,0.5))'} : {}}>
              {/* Outer bevel ring */}
              <polygon points={hexPoints(n.x, n.y, r)} fill={bevelFill}
                stroke={isActive ? '#FFE89A' : 'rgba(255,184,54,0.25)'} strokeWidth={isActive ? 0.8 : 1} strokeOpacity={0.7}/>
              {/* Inner face */}
              <polygon points={hexPoints(n.x, n.y, inner)} fill={faceFill}
                stroke="#000" strokeWidth="0.8" strokeOpacity={isActive ? 0.35 : 0.15}/>
              {isActive && <polygon points={hexPoints(n.x, n.y, inner)} fill="none" stroke="#FFE89A" strokeWidth="0.6" strokeOpacity="0.5"/>}

              {/* Glyph */}
              {isCore ? (
                <g stroke="#FFE89A" strokeWidth="2.5" fill="none" strokeLinecap="round">
                  <line x1={n.x-9} y1={n.y-11} x2={n.x-9} y2={n.y+11}/>
                  <line x1={n.x+9} y1={n.y-11} x2={n.x+9} y2={n.y+11}/>
                  <line x1={n.x-9} y1={n.y} x2={n.x+9} y2={n.y}/>
                </g>
              ) : (
                <polygon
                  points={hexPoints(n.x, n.y, 8)}
                  fill="none"
                  stroke={isActive ? '#FFE89A' : '#9A6A30'}
                  strokeWidth="1.2"
                  strokeOpacity={isActive ? 0.85 : 0.55}
                />
              )}

              <text x={n.x} y={n.y + r + 18} textAnchor="middle"
                fill={isActive ? '#FFD68A' : '#7C7060'}
                style={{font:'600 10px/12px Manrope', letterSpacing:'.08em', textTransform:'uppercase'}}>
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
};

window.OperationsMap = OperationsMap;
