const AgentList = () => {
  const agents = [
    { name:'Inbox Triage', role:'communications', state:'run', lat:'1.2s', util:78 },
    { name:'Vendor Reconciler', role:'finance', state:'ok', lat:'4.7s', util:42 },
    { name:'Lead Enricher', role:'sales', state:'run', lat:'820ms', util:64 },
    { name:'Renewal Monitor', role:'success', state:'approve', lat:'—', util:12 },
    { name:'Knowledge Indexer', role:'ops', state:'ok', lat:'12.4s', util:88 },
  ];
  return (
    <Card padded={false}>
      <div style={{padding:'16px 18px 12px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <div>
          <Eyebrow>Agent swarm</Eyebrow>
          <div style={{font:'600 16px/22px Manrope', color:'#F2EBDD', marginTop:2}}>5 agents active</div>
        </div>
        <Button variant="ghost" icon="add">Add agent</Button>
      </div>
      <div>
        {agents.map((a, i) => (
          <div key={i} style={{
            display:'flex', alignItems:'center', gap:14,
            padding:'12px 18px',
            borderTop: i ? '1px solid rgba(255,255,255,0.04)' : 'none',
          }}>
            <Hex size={28} fill="rgba(229,154,27,0.1)" stroke={a.state === 'run' ? '#E59A1B' : '#B8895A'} strokeWidth={1.2} glow={a.state === 'run'}>
              <g stroke={a.state === 'run' ? '#FFC562' : '#B8895A'} strokeWidth="1.2" fill="none" strokeLinecap="square">
                <line x1="9" y1="8" x2="9" y2="16"/>
                <line x1="15" y1="8" x2="15" y2="16"/>
                <line x1="9" y1="12" x2="15" y2="12"/>
              </g>
            </Hex>
            <div style={{flex:1, minWidth:0}}>
              <div style={{font:'600 13px/16px Manrope', color:'#F2EBDD'}}>{a.name}</div>
              <div style={{font:'400 11px/14px JetBrains Mono', color:'#6F6A60', marginTop:2}}>role · {a.role}</div>
            </div>
            <div style={{width:80}}>
              <div style={{height:4, background:'#262A2F', borderRadius:2, overflow:'hidden'}}>
                <div style={{height:'100%', width:`${a.util}%`, background: a.state === 'run' ? '#E59A1B' : '#7E9B7E'}}/>
              </div>
              <div style={{font:'400 10px/12px JetBrains Mono', color:'#6F6A60', marginTop:4, textAlign:'right'}}>{a.util}%</div>
            </div>
            <div style={{font:'400 12px/14px JetBrains Mono', color:'#B8B0A0', width:54, textAlign:'right'}}>{a.lat}</div>
            <Badge kind={a.state}>{a.state === 'run' ? 'Running' : a.state === 'approve' ? 'Approval' : 'OK'}</Badge>
          </div>
        ))}
      </div>
    </Card>
  );
};

window.AgentList = AgentList;
