const NewAutomationModal = ({ open, onClose }) => {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('Vendor invoice triage');
  const [trigger, setTrigger] = useState('email');
  if (!open) return null;
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(11,12,14,0.6)', backdropFilter:'blur(12px) saturate(140%)',
      display:'grid', placeItems:'center', zIndex:50,
    }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{
        width:560, background:'#14161A', border:'1px solid rgba(255,255,255,0.08)',
        borderRadius:18, boxShadow:'0 24px 64px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.05) inset',
        overflow:'hidden',
      }}>
        <div style={{padding:'20px 24px 16px', borderBottom:'1px solid rgba(255,255,255,0.06)', display:'flex', alignItems:'center', gap:12}}>
          <Hex size={28} fill="rgba(229,154,27,0.15)" stroke="#E59A1B" strokeWidth={1.5} glow/>
          <div style={{flex:1}}>
            <Eyebrow>New automation</Eyebrow>
            <div style={{font:'600 18px/24px Manrope', color:'#F2EBDD', marginTop:2}}>
              {['Name & describe', 'Choose trigger', 'Review'][step]}
            </div>
          </div>
          <div style={{display:'flex', gap:6}}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width:24, height:3, borderRadius:2,
                background: i <= step ? '#E59A1B' : '#262A2F',
              }}/>
            ))}
          </div>
        </div>

        <div style={{padding:'20px 24px', display:'flex', flexDirection:'column', gap:14}}>
          {step === 0 && (
            <>
              <div>
                <Eyebrow style={{marginBottom:6}}>Name</Eyebrow>
                <div style={{display:'flex', alignItems:'center', background:'#0F1114', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'10px 12px'}}>
                  <input value={name} onChange={e => setName(e.target.value)} style={{flex:1, background:'transparent', border:0, color:'#F2EBDD', fontFamily:'Manrope', fontSize:14, outline:'none'}}/>
                </div>
              </div>
              <div>
                <Eyebrow style={{marginBottom:6}}>What should this automation do?</Eyebrow>
                <textarea defaultValue="Triage incoming vendor invoices, match to PO, and route to finance." style={{width:'100%', minHeight:80, background:'#0F1114', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'10px 12px', color:'#F2EBDD', fontFamily:'Manrope', fontSize:13, outline:'none', resize:'vertical', boxSizing:'border-box'}}/>
              </div>
            </>
          )}

          {step === 1 && (
            <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:10}}>
              {[
                { id:'email', icon:'bell', label:'Email arrives', sub:'Inbox · vendor@' },
                { id:'schedule', icon:'runs', label:'On schedule', sub:'Cron · 9:00 daily' },
                { id:'webhook', icon:'layers', label:'Webhook', sub:'POST /hook/v1' },
                { id:'manual', icon:'play', label:'Manual', sub:'Human starts' },
              ].map(t => (
                <div key={t.id} onClick={() => setTrigger(t.id)} style={{
                  padding:14, borderRadius:12, cursor:'pointer',
                  background: trigger === t.id ? 'rgba(229,154,27,0.08)' : '#0F1114',
                  border:`1px solid ${trigger === t.id ? 'rgba(229,154,27,0.45)' : 'rgba(255,255,255,0.06)'}`,
                  display:'flex', gap:10, alignItems:'flex-start',
                }}>
                  <Hex size={24} fill="rgba(229,154,27,0.1)" stroke={trigger === t.id ? '#E59A1B' : '#B8895A'} strokeWidth={1.2}/>
                  <div>
                    <div style={{font:'600 13px/16px Manrope', color:'#F2EBDD'}}>{t.label}</div>
                    <div style={{font:'400 11px/14px JetBrains Mono', color:'#6F6A60', marginTop:2}}>{t.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {step === 2 && (
            <div style={{background:'#0F1114', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'14px 16px'}}>
              <Eyebrow style={{marginBottom:6}}>Summary</Eyebrow>
              <div style={{display:'flex', flexDirection:'column', gap:8, marginTop:6}}>
                <div style={{display:'flex', justifyContent:'space-between', font:'400 13px/18px Manrope'}}><span style={{color:'#6F6A60'}}>Name</span><span style={{color:'#F2EBDD'}}>{name}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', font:'400 13px/18px Manrope'}}><span style={{color:'#6F6A60'}}>Trigger</span><span style={{color:'#F2EBDD', textTransform:'capitalize'}}>{trigger}</span></div>
                <div style={{display:'flex', justifyContent:'space-between', font:'400 13px/18px Manrope'}}><span style={{color:'#6F6A60'}}>Hive</span><span style={{color:'#F2EBDD'}}>Acme Operations</span></div>
                <div style={{display:'flex', justifyContent:'space-between', font:'400 13px/18px Manrope'}}><span style={{color:'#6F6A60'}}>Approval</span><span style={{color:'#F2EBDD'}}>Required for &gt; $500</span></div>
              </div>
            </div>
          )}
        </div>

        <div style={{padding:'14px 24px', borderTop:'1px solid rgba(255,255,255,0.06)', display:'flex', justifyContent:'space-between'}}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <div style={{display:'flex', gap:8}}>
            {step > 0 && <Button variant="secondary" onClick={() => setStep(s => s-1)}>Back</Button>}
            {step < 2
              ? <Button variant="primary" onClick={() => setStep(s => s+1)}>Continue</Button>
              : <Button variant="primary" icon="approve" onClick={onClose}>Build automation</Button>}
          </div>
        </div>
      </div>
    </div>
  );
};

window.NewAutomationModal = NewAutomationModal;
