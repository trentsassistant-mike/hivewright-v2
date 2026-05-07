const RunsTable = () => {
  const rows = [
    { id:'run_4823', wf:'Invoice triage', agent:'Vendor Reconciler', state:'ok', lat:'1.2s', t:'12:04:21' },
    { id:'run_4822', wf:'Lead enrich', agent:'Lead Enricher', state:'run', lat:'—', t:'12:04:18' },
    { id:'run_4821', wf:'Vendor sync', agent:'Vendor Reconciler', state:'ok', lat:'4.7s', t:'12:03:50' },
    { id:'run_4820', wf:'Inbox triage', agent:'Inbox Triage', state:'fail', lat:'920ms', t:'12:03:42' },
    { id:'run_4819', wf:'Renewal review', agent:'Renewal Monitor', state:'approve', lat:'—', t:'12:03:30' },
    { id:'run_4818', wf:'Inbox triage', agent:'Inbox Triage', state:'ok', lat:'1.1s', t:'12:03:18' },
  ];
  const stateLabel = { ok:'OK', run:'Running', fail:'Failed', approve:'Approval req.' };
  return (
    <Card padded={false}>
      <div style={{padding:'16px 18px 12px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:'1px solid rgba(255,255,255,0.06)'}}>
        <div>
          <Eyebrow>Recent runs</Eyebrow>
          <div style={{font:'600 16px/22px Manrope', color:'#F2EBDD', marginTop:2}}>Last 24 hours · 1,284 runs</div>
        </div>
        <div style={{display:'flex', gap:8}}>
          <Button variant="ghost" icon="filter">Filter</Button>
          <Button variant="ghost" icon="sort">Sort</Button>
        </div>
      </div>
      <table style={{width:'100%', borderCollapse:'collapse'}}>
        <thead>
          <tr>
            {['Run','Workflow','Agent','Status','Latency','Started'].map((h, i) => (
              <th key={h} style={{
                textAlign: i >= 4 ? 'right' : 'left',
                padding:'10px 18px',
                font:'600 10px/12px Manrope', letterSpacing:'.08em', textTransform:'uppercase', color:'#6F6A60',
                background:'#1B1E22', borderTop:'1px solid rgba(255,255,255,0.06)', borderBottom:'1px solid rgba(255,255,255,0.06)',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{borderTop:'1px solid rgba(255,255,255,0.04)'}}>
              <td style={{padding:'10px 18px', font:'400 12px/16px JetBrains Mono', color:'#B8B0A0'}}>{r.id}</td>
              <td style={{padding:'10px 18px', font:'500 13px/16px Manrope', color:'#F2EBDD'}}>{r.wf}</td>
              <td style={{padding:'10px 18px', font:'400 13px/16px Manrope', color:'#B8B0A0'}}>{r.agent}</td>
              <td style={{padding:'10px 18px'}}><Badge kind={r.state}>{stateLabel[r.state]}</Badge></td>
              <td style={{padding:'10px 18px', font:'400 12px/16px JetBrains Mono', color:'#B8B0A0', textAlign:'right'}}>{r.lat}</td>
              <td style={{padding:'10px 18px', font:'400 12px/16px JetBrains Mono', color:'#6F6A60', textAlign:'right'}}>{r.t}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
};

window.RunsTable = RunsTable;
