const TopBar = ({ title, eyebrow, actions }) => {
  return (
    <header style={{
      height:56, flexShrink:0,
      borderBottom:'1px solid rgba(255,255,255,0.06)',
      display:'flex', alignItems:'center', padding:'0 24px', gap:16,
    }}>
      <div style={{flex:1}}>
        {eyebrow && <div style={{font:'600 10px/12px Manrope', letterSpacing:'.08em', textTransform:'uppercase', color:'#6F6A60', marginBottom:2}}>{eyebrow}</div>}
        <div style={{font:'600 17px/20px Manrope', color:'#F2EBDD', letterSpacing:'-0.005em'}}>{title}</div>
      </div>
      {/* Search */}
      <div style={{
        display:'flex', alignItems:'center', gap:8,
        background:'#0F1114', border:'1px solid rgba(255,255,255,0.06)',
        borderRadius:10, padding:'7px 12px', width:280,
      }}>
        <Icon name="search" size={14} style={{color:'#6F6A60'}} />
        <input placeholder="Search hives, agents, runs…" style={{
          flex:1, background:'transparent', border:0, color:'#F2EBDD',
          fontFamily:'Manrope', fontSize:13, outline:'none',
        }} />
        <kbd style={{
          font:'500 10px/12px JetBrains Mono', color:'#6F6A60',
          padding:'2px 5px', border:'1px solid rgba(255,255,255,0.08)', borderRadius:4,
        }}>⌘K</kbd>
      </div>
      <button style={{
        background:'transparent', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10,
        width:34, height:34, color:'#B8B0A0', cursor:'pointer', position:'relative',
      }}>
        <Icon name="bell" size={16} />
        <span style={{
          position:'absolute', top:6, right:7, width:6, height:6, borderRadius:'50%',
          background:'#E59A1B', boxShadow:'0 0 8px #E59A1B',
        }} />
      </button>
      {actions}
    </header>
  );
};

window.TopBar = TopBar;
