// Shared primitives — Molten Honey edition
const { useState, useEffect, useRef, useMemo } = React;

const Icon = ({ name, size = 18, style, className, color }) => (
  <svg width={size} height={size} className={className} style={{display:'inline-block', verticalAlign:'middle', color, ...style}}>
    <use href={`../../assets/icons/icons.svg#${name}`} />
  </svg>
);

// Reusable gradient defs — drop once into a host SVG or rely on the per-instance defs in MoltenHex.
const HexGradients = ({ id = 'mh' }) => (
  <defs>
    <linearGradient id={`${id}-bevel`} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stopColor="#FFE89A"/><stop offset="50%" stopColor="#E59A1B"/><stop offset="100%" stopColor="#5C3206"/>
    </linearGradient>
    <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="#FFD56A"/><stop offset="22%" stopColor="#F0A416"/>
      <stop offset="50%" stopColor="#9A5400"/><stop offset="78%" stopColor="#F0A416"/>
      <stop offset="100%" stopColor="#FFD56A"/>
    </linearGradient>
    <linearGradient id={`${id}-faceDim`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stopColor="rgba(255,213,106,0.35)"/><stop offset="50%" stopColor="rgba(154,84,0,0.25)"/>
      <stop offset="100%" stopColor="rgba(255,213,106,0.30)"/>
    </linearGradient>
  </defs>
);

// MoltenHex — beveled photoreal-ish hex with optional inner glyph + glow
const MoltenHex = ({ size = 32, glyph = null, dim = false, glow = true, style }) => {
  const id = useMemo(() => `mh-${Math.random().toString(36).slice(2,8)}`, []);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      style={{filter: glow && !dim ? 'drop-shadow(0 0 6px rgba(255,184,54,0.55)) drop-shadow(0 0 14px rgba(229,154,27,0.25))' : undefined, ...style}}>
      <defs>
        <linearGradient id={`${id}-bevel`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFE89A"/><stop offset="50%" stopColor="#E59A1B"/><stop offset="100%" stopColor="#5C3206"/>
        </linearGradient>
        <linearGradient id={`${id}-face`} x1="0" y1="0" x2="0" y2="1">
          {dim ? (<>
            <stop offset="0%" stopColor="rgba(255,213,106,0.18)"/>
            <stop offset="50%" stopColor="rgba(154,84,0,0.12)"/>
            <stop offset="100%" stopColor="rgba(255,213,106,0.18)"/>
          </>) : (<>
            <stop offset="0%" stopColor="#FFD56A"/><stop offset="22%" stopColor="#F0A416"/>
            <stop offset="50%" stopColor="#9A5400"/><stop offset="78%" stopColor="#F0A416"/>
            <stop offset="100%" stopColor="#FFD56A"/>
          </>)}
        </linearGradient>
      </defs>
      {/* outer bevel */}
      <polygon points="12,1 21,6 21,18 12,23 3,18 3,6"
        fill={dim ? 'rgba(229,154,27,0.25)' : `url(#${id}-bevel)`}
        stroke={dim ? 'rgba(229,154,27,0.45)' : '#FFE89A'} strokeWidth={dim ? 1 : 0.5} strokeOpacity={dim ? 0.6 : 0.6}/>
      {/* inner face */}
      <polygon points="12,2.5 19.6,7 19.6,17 12,21.5 4.4,17 4.4,7"
        fill={`url(#${id}-face)`}
        stroke="#000" strokeWidth="0.5" strokeOpacity={dim ? 0.15 : 0.3}/>
      {!dim && <polygon points="12,2.5 19.6,7 19.6,17 12,21.5 4.4,17 4.4,7"
        fill="none" stroke="#FFE89A" strokeWidth="0.4" strokeOpacity="0.6"/>}
      {glyph && <g transform="translate(6,6)">{glyph}</g>}
    </svg>
  );
};

// Backwards compat alias
const Hex = MoltenHex;

const Button = ({ variant = 'secondary', children, icon, onClick, style, size = 'md' }) => {
  const sizes = {
    sm: { padding:'6px 10px', fontSize:12 },
    md: { padding:'8px 14px', fontSize:13 },
    lg: { padding:'10px 18px', fontSize:14 },
  };
  const base = {
    fontFamily:'inherit', fontWeight:600,
    borderRadius:10, cursor:'pointer',
    border:'1px solid transparent', display:'inline-flex', alignItems:'center', gap:8,
    transition:'all 120ms cubic-bezier(0.2,0.8,0.2,1)',
    ...sizes[size],
  };
  // Molten primary uses a true gradient + bevel ring + warm glow
  const variants = {
    primary: {
      background: 'linear-gradient(180deg, #FFD56A 0%, #F0A416 30%, #B86E08 100%)',
      color:'#1A0A00',
      borderColor:'#FFE89A',
      boxShadow:'inset 0 1px 0 rgba(255,232,154,0.7), 0 0 0 1px rgba(255,184,54,0.35), 0 6px 20px -6px rgba(229,154,27,0.65)',
      textShadow:'0 1px 0 rgba(255,232,154,0.4)',
    },
    secondary: { background:'#1B1612', color:'#F2EBDD', borderColor:'rgba(255,184,54,0.18)' },
    ghost: { background:'transparent', color:'#C9BDA1', borderColor:'rgba(255,184,54,0.10)' },
    danger: { background:'transparent', color:'#E26A4C', borderColor:'rgba(194,74,44,0.4)' },
  };
  return (
    <button onClick={onClick} style={{...base, ...variants[variant], ...style}}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </button>
  );
};

const Badge = ({ kind = 'idle', children }) => {
  const map = {
    ok: { c:'#B8D4B8', bg:'rgba(126,155,126,0.08)', bd:'rgba(126,155,126,0.3)', dot:'#7E9B7E', glow:true },
    run: { c:'#FFD68A', bg:'rgba(229,154,27,0.10)', bd:'rgba(255,184,54,0.35)', dot:'#FFB836', glow:true, pulse:true },
    approve: { c:'#F2EBDD', bg:'rgba(255,255,255,0.04)', bd:'rgba(255,255,255,0.12)', dot:'#B8B0A0' },
    fail: { c:'#E89682', bg:'rgba(194,74,44,0.10)', bd:'rgba(194,74,44,0.35)', dot:'#C24A2C' },
    idle: { c:'#7C7060', bg:'transparent', bd:'rgba(255,255,255,0.06)', dot:'#7C7060' },
  }[kind];
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:6,
      padding:'4px 10px', borderRadius:6,
      fontSize:11, fontWeight:600, letterSpacing:'.04em', textTransform:'uppercase',
      color: map.c, background: map.bg, border: `1px solid ${map.bd}`,
    }}>
      <span style={{
        width:6, height:6, borderRadius:'50%', background: map.dot,
        boxShadow: map.glow ? `0 0 8px ${map.dot}` : 'none',
        animation: map.pulse ? 'hwPulse 2.4s cubic-bezier(0.2,0.8,0.2,1) infinite' : 'none',
      }} />
      {children}
    </span>
  );
};

const Card = ({ children, style, padded = true, onClick, hoverable, accent = false }) => {
  const [h, setH] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setH(true)}
      onMouseLeave={() => setH(false)}
      style={{
        position:'relative',
        background:'linear-gradient(180deg, #15110D 0%, #0F0B07 100%)',
        border:`1px solid ${(hoverable && h) || accent ? 'rgba(255,184,54,0.22)' : 'rgba(255,184,54,0.08)'}`,
        borderRadius:14,
        padding: padded ? 18 : 0,
        boxShadow: accent
          ? 'inset 0 1px 0 rgba(255,232,154,0.06), 0 0 0 1px rgba(255,184,54,0.05), 0 12px 32px -8px rgba(0,0,0,0.6), 0 0 40px -8px rgba(229,154,27,0.18)'
          : 'inset 0 1px 0 rgba(255,232,154,0.04), 0 12px 32px -8px rgba(0,0,0,0.55)',
        cursor: onClick ? 'pointer' : 'default',
        transition:'border-color 160ms cubic-bezier(0.2,0.8,0.2,1)',
        overflow: 'hidden',
        ...style,
      }}>
      {children}
    </div>
  );
};

const Eyebrow = ({ children, style }) => (
  <div style={{font:'600 11px/14px Manrope', letterSpacing:'.08em', textTransform:'uppercase', color:'#7C7060', ...style}}>{children}</div>
);

Object.assign(window, { Icon, Hex, MoltenHex, HexGradients, Button, Badge, Card, Eyebrow });
