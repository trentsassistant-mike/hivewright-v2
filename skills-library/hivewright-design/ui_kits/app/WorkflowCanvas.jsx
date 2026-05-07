const WorkflowCanvas = ({ onCreate }) => {
  const [nodes, setNodes] = useState([
    { id:1, x:120, y:160, label:'Trigger · email arrives', icon:'bell', kind:'trigger' },
    { id:2, x:340, y:160, label:'Classify intent', icon:'sparkle', kind:'agent' },
    { id:3, x:560, y:80, label:'Reply (auto)', icon:'play', kind:'action' },
    { id:4, x:560, y:240, label:'Approval req.', icon:'shield', kind:'approval' },
  ]);
  const [drag, setDrag] = useState(null);

  const onMouseDown = (e, id) => {
    const start = { x: e.clientX, y: e.clientY };
    const orig = nodes.find(n => n.id === id);
    setDrag({ id, start, orig });
  };
  useEffect(() => {
    if (!drag) return;
    const move = e => {
      setNodes(ns => ns.map(n => n.id === drag.id ? {...n, x: drag.orig.x + (e.clientX - drag.start.x), y: drag.orig.y + (e.clientY - drag.start.y)} : n));
    };
    const up = () => setDrag(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [drag]);

  const edges = [[1,2],[2,3],[2,4]];
  const get = id => nodes.find(n => n.id === id);

  const kindStyle = {
    trigger:  { stroke:'#7E9B7E', fill:'rgba(126,155,126,0.08)', glow:false },
    agent:    { stroke:'#E59A1B', fill:'rgba(229,154,27,0.12)', glow:true },
    action:   { stroke:'#B8895A', fill:'rgba(184,137,90,0.08)', glow:false },
    approval: { stroke:'#E26A4C', fill:'rgba(226,106,76,0.08)', glow:false },
  };

  return (
    <div style={{flex:1, position:'relative', background:'#0B0C0E', overflow:'hidden'}}>
      {/* Hex paper bg */}
      <svg style={{position:'absolute', inset:0, width:'100%', height:'100%'}}>
        <defs>
          <pattern id="paperhex" x="0" y="0" width="48" height="56" patternUnits="userSpaceOnUse">
            <path d="M12 0 L24 0 L30 10.4 L24 20.7 L12 20.7 L6 10.4 Z M36 28 L48 28 L54 38.4 L48 48.7 L36 48.7 L30 38.4 Z" stroke="rgba(184,137,90,0.08)" strokeWidth="0.6" fill="none"/>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#paperhex)"/>
      </svg>

      {/* Top toolbar */}
      <div style={{position:'absolute', top:16, left:16, right:16, display:'flex', alignItems:'center', gap:8, zIndex:5}}>
        <div style={{
          background:'#14161A', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10,
          padding:'6px 10px', display:'flex', gap:6,
        }}>
          <Button variant="ghost" icon="add" style={{padding:'5px 10px', fontSize:12}}>Trigger</Button>
          <Button variant="ghost" icon="agents" style={{padding:'5px 10px', fontSize:12}}>Agent</Button>
          <Button variant="ghost" icon="play" style={{padding:'5px 10px', fontSize:12}}>Action</Button>
          <Button variant="ghost" icon="shield" style={{padding:'5px 10px', fontSize:12}}>Approval</Button>
        </div>
        <div style={{flex:1}}/>
        <Button variant="ghost" icon="play">Test run</Button>
        <Button variant="primary" icon="approve" onClick={onCreate}>Publish workflow</Button>
      </div>

      {/* Edges */}
      <svg style={{position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none'}}>
        {edges.map(([f,t], i) => {
          const a = get(f), b = get(t);
          if (!a || !b) return null;
          const path = `M${a.x+50},${a.y} C ${(a.x+b.x)/2+50},${a.y} ${(a.x+b.x)/2-50},${b.y} ${b.x-50},${b.y}`;
          return <path key={i} d={path} fill="none" stroke="#E59A1B" strokeWidth="1.5" strokeDasharray="3 4" style={{animation:'hwFlow 1.4s linear infinite'}}/>;
        })}
      </svg>

      {/* Nodes */}
      {nodes.map(n => {
        const s = kindStyle[n.kind];
        return (
          <div key={n.id}
            onMouseDown={e => onMouseDown(e, n.id)}
            style={{
              position:'absolute', left: n.x - 100, top: n.y - 36,
              width:200, height:72, padding:'10px 14px',
              background:'#14161A', border:`1px solid ${s.stroke}`, borderRadius:12,
              boxShadow: s.glow ? '0 0 0 1px rgba(229,154,27,0.35), 0 0 24px -4px rgba(229,154,27,0.45)' : '0 8px 24px rgba(0,0,0,0.4)',
              cursor: drag?.id === n.id ? 'grabbing' : 'grab',
              display:'flex', alignItems:'center', gap:10,
              userSelect:'none',
            }}>
            <Hex size={32} fill={s.fill} stroke={s.stroke} strokeWidth={1.2}>
              <g transform="translate(6,6) scale(0.5)" stroke={s.stroke} strokeWidth="1.5" fill="none" strokeLinecap="square">
                <use href={`../../assets/icons/icons.svg#${n.icon}`} width="24" height="24"/>
              </g>
            </Hex>
            <div style={{flex:1}}>
              <div style={{font:'600 11px/14px Manrope', letterSpacing:'.08em', textTransform:'uppercase', color: s.stroke}}>{n.kind}</div>
              <div style={{font:'500 13px/16px Manrope', color:'#F2EBDD', marginTop:3}}>{n.label}</div>
            </div>
          </div>
        );
      })}

      {/* Help hint */}
      <div style={{position:'absolute', bottom:16, left:16, font:'400 12px/16px JetBrains Mono', color:'#6F6A60'}}>
        Drag nodes · click toolbar to add steps · ⌘S to publish
      </div>
    </div>
  );
};

window.WorkflowCanvas = WorkflowCanvas;
