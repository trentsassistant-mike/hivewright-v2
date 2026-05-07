const Suggestions = () => {
  const items = [
    { title:'Auto-approve low-risk vendor invoices', body:'73% of approvals < $500 ran the same path. Skipping human approval would save ~4h/wk.', accent:'honey' },
    { title:'Add retry policy to Inbox Triage', body:'4 timeouts in the last 24h on the same downstream. Suggest 2 retries with 5s backoff.', accent:'sage' },
  ];
  return (
    <Card padded={false}>
      <div style={{padding:'16px 18px 12px', display:'flex', alignItems:'center', gap:8, borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <Icon name="sparkle" size={14} style={{color:'#FFC562'}}/>
        <div style={{font:'600 13px/16px Manrope', color:'#F2EBDD'}}>Suggested improvements</div>
      </div>
      {items.map((it, i) => (
        <div key={i} style={{padding:'14px 18px', borderTop: i ? '1px solid rgba(255,255,255,0.04)' : 'none'}}>
          <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
            <div style={{
              width:6, alignSelf:'stretch', borderRadius:3,
              background: it.accent === 'honey' ? '#E59A1B' : '#7E9B7E', opacity:.8,
            }}/>
            <div style={{flex:1}}>
              <div style={{font:'600 13px/18px Manrope', color:'#F2EBDD'}}>{it.title}</div>
              <div style={{font:'400 12px/18px Manrope', color:'#B8B0A0', marginTop:4}}>{it.body}</div>
              <div style={{display:'flex', gap:8, marginTop:10}}>
                <Button variant="primary" style={{padding:'6px 12px', fontSize:12}}>Apply</Button>
                <Button variant="ghost" style={{padding:'6px 12px', fontSize:12}}>Dismiss</Button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </Card>
  );
};

window.Suggestions = Suggestions;
