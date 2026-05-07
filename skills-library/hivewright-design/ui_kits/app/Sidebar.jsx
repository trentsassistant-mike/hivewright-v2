const Sidebar = ({ active, onNav }) => {
  const [hiveOpen, setHiveOpen] = useState(false);
  const items = [
    { id:'overview', icon:'overview', label:'Overview' },
    { id:'hives', icon:'hives', label:'Hives' },
    { id:'agents', icon:'agents', label:'Agents' },
    { id:'automations', icon:'automations', label:'Automations' },
    { id:'workflows', icon:'workflows', label:'Workflows' },
    { id:'runs', icon:'runs', label:'Runs' },
    { id:'knowledge', icon:'knowledge', label:'Knowledge' },
  ];
  return (
    <aside style={{
      width:240, flexShrink:0,
      background:'#0F1114',
      borderRight:'1px solid rgba(255,255,255,0.06)',
      display:'flex', flexDirection:'column',
      padding:'16px 12px',
      position:'relative', zIndex:2,
    }}>
      {/* Brand */}
      <div style={{display:'flex', alignItems:'center', gap:10, padding:'4px 6px 18px'}}>
        <img src="../../assets/brand/hivewright_mark.svg" width="28" height="28" alt="" />
        <div style={{font:'500 18px/22px Fraunces', color:'#F2EBDD', letterSpacing:'-0.01em'}}>Hivewright</div>
      </div>

      {/* Hive switcher */}
      <button onClick={() => setHiveOpen(o => !o)} style={{
        background:'#14161A', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10,
        padding:'10px 12px', display:'flex', alignItems:'center', gap:10, color:'#F2EBDD',
        fontFamily:'Manrope', fontSize:13, fontWeight:600, cursor:'pointer', textAlign:'left',
        marginBottom:14,
      }}>
        <Hex size={20} fill="rgba(229,154,27,0.2)" stroke="#E59A1B" strokeWidth={1.5} glow />
        <div style={{flex:1, lineHeight:'14px'}}>
          <div>Acme Operations</div>
          <div style={{fontSize:11, fontWeight:400, color:'#6F6A60', marginTop:2}}>3 hives · production</div>
        </div>
        <Icon name="more" size={14} style={{color:'#6F6A60'}} />
      </button>

      {/* Nav */}
      <nav style={{display:'flex', flexDirection:'column', gap:1}}>
        {items.map(it => (
          <button key={it.id} onClick={() => onNav(it.id)} style={{
            display:'flex', alignItems:'center', gap:12,
            padding:'9px 10px', borderRadius:8,
            background: active === it.id ? '#1B1E22' : 'transparent',
            border:'1px solid', borderColor: active === it.id ? 'rgba(229,154,27,0.25)' : 'transparent',
            color: active === it.id ? '#F2EBDD' : '#B8B0A0',
            fontFamily:'Manrope', fontSize:13, fontWeight: active === it.id ? 600 : 500,
            cursor:'pointer', textAlign:'left',
            transition:'all 120ms cubic-bezier(0.2,0.8,0.2,1)',
          }}>
            <Icon name={it.icon} size={18} style={{color: active === it.id ? '#FFC562' : '#6F6A60'}} />
            {it.label}
            {it.id === 'automations' && <span style={{marginLeft:'auto', fontSize:11, color:'#FFC562', fontWeight:600}}>2</span>}
          </button>
        ))}
      </nav>

      <div style={{flex:1}} />

      {/* Footer */}
      <button onClick={() => onNav('settings')} style={{
        display:'flex', alignItems:'center', gap:12,
        padding:'9px 10px', borderRadius:8,
        background:'transparent', border:'none',
        color: active === 'settings' ? '#F2EBDD' : '#6F6A60',
        fontFamily:'Manrope', fontSize:13, fontWeight:500, cursor:'pointer',
      }}>
        <Icon name="settings" size={18} />
        Settings
      </button>
      <div style={{
        marginTop:8, padding:'10px 12px', background:'#14161A', borderRadius:10,
        border:'1px solid rgba(255,255,255,0.06)',
        display:'flex', alignItems:'center', gap:10,
      }}>
        <div style={{width:28, height:28, borderRadius:'50%', background:'linear-gradient(135deg,#E59A1B,#5C3A06)', display:'grid', placeItems:'center', color:'#1A0F00', fontWeight:700, fontSize:12}}>EM</div>
        <div style={{flex:1, lineHeight:'14px'}}>
          <div style={{fontSize:12, color:'#F2EBDD', fontWeight:600}}>Eli Marsh</div>
          <div style={{fontSize:11, color:'#6F6A60', marginTop:2}}>Operator</div>
        </div>
      </div>
    </aside>
  );
};

window.Sidebar = Sidebar;
